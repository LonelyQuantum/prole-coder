# 运行日志（Run Log）

状态：Phase 1 基础存储层和写入串行化已实现，并已接入基础 Agent Turn Loop、CLI `run` 和 RPC Turn Loop handler；Phase 2d 已加入统一脱敏/截断边界；Phase 3 RPC 全双工事件发送队列已复用同一份 Run Log 作为事实来源。

Run Log 是 Agent Core 的本地审计记录。它记录一次 run 中发生的事件，使 CLI、TUI、VS Code 和后续调试工具能够读取同一份事实来源。Run Log 不等同于模型上下文；进入上下文前仍需要 Context Capsule 做筛选、摘要、脱敏和 token 预算。

## 目标

- 追加写入，不重写历史事件。
- 每条事件有单调递增的 `seq`。
- 事件可以按原顺序读取，用于 resume、回放和调试。
- 写入前执行基础敏感信息脱敏。
- 日志路径固定在 workspace 内，不依赖 shell 当前目录。

## 存储位置

默认位置：

```text
<workspace>/.prole-coder/runs/<runId>/events.jsonl
<workspace>/.prole-coder/runs/<runId>/summary.json
<workspace>/.prole-coder/runs/<runId>/diagnostics/*.json
<workspace>/.prole-coder/runs/<runId>/payloads/**
```

`.prole-coder/` 已在 `.gitignore` 中排除，run log 不应进入 Git 仓库。

## Rust 实现

实现位置：

```text
crates/agent-core/src/run_log.rs
```

核心类型：

- `RunLogStore`：绑定 workspace root 和 state dir，负责创建、打开和读取 run。
- `RunLog`：单 writer 追加句柄，维护下一条 `seq`。
- `RunLogWriter`：Turn Loop 使用的写入 trait，让单 writer 和同步 writer 共享同一套回合编排。
- `SerializedRunLog`：`Mutex<RunLog>` 包装，用于跨线程或前端 request 边界串行化同一 run 的 append/load。
- `RunSummary` / `RunSummaryStatus`：每个 run 的轻量 metadata，用于 `agent.listRuns`。
- `RunLogEvent`：JSONL 中的一条事件。
- `RunLogError`：路径、序列、JSON、I/O 和标识符错误。

## 写入并发边界

`RunLog` 仍是最小单 writer 句柄，适合 CLI `run` 这种同步流程。它通过 `&mut self` 保证同一代码路径不能同时追加两条事件。

`SerializedRunLog` 用于 RPC 等跨线程场景。它把同一个 `RunLog` 放入 `Mutex`，所有 clone 共享同一个 `next_seq` 和文件句柄状态；每次 append 都先拿锁，写入完成并推进 `seq` 后释放。`load` 也走同一把锁，避免 active run 正在写入时，`agent.resume` 从磁盘读到半条事件或不一致的序列。

Run Log 本身负责 append/load 串行化，并允许 Turn Loop 在同一 run 目录下写入受控诊断文件。Phase 3 的 RPC live event queue 建在 `TurnEventSink` 之上：事件先成功追加到 Run Log，再投递给 request loop 的单 writer 输出为 `agent.event` notification。因此前端看到的 live notification 与后续 `agent.resume` 回放共享同一组 `seq` 和 payload。

当 provider 返回的 tool-call `function.arguments` 无法解析为 JSON 时，Turn Loop 会在 `diagnostics/invalid-tool-arguments-<sanitizedToolCallId>-<hash>.json` 写入脱敏后的累计 arguments、JSON 解析错误和 run/turn/tool metadata；对应 `run.failed` payload 会带 `diagnosticFile` 路径，便于 VS Code Output 或 Sidebar failure card 直接定位。文件名中的短哈希来自原始 tool call id，用于避免 sanitize 或截断后的名称碰撞。诊断文件继续留在 `.prole-coder/`，不应上传或同步。

大工具参数使用 `payloads/`：本地聚合器可以把 provider streaming chunk 追加到当前 run 的 payload 文件，最终 tool call 只通过 `payloadRef` 引用该文件。Run Log 只允许 workspace-relative run-scoped 路径，拒绝绝对路径和 `..`；payload 文件不会自动追加换行，避免改变 patch 内容。

## Summary Metadata

每个 run 创建时会同步创建 `summary.json`。之后每次成功追加事件，Run Log 会根据事件更新 summary：

- `run.started`：记录 `startedAtUnixMs`、`mode` 和运行状态。
- `turn.started`：使用已脱敏的 `userTask` 更新 `title`；如果 payload 带 `supersedes`，表示该新 turn 是编辑重发并覆盖某个历史用户消息的展示语义，Run Log 仍保留旧 turn 原始输入用于审计。
- `turn.steered`：记录 active run 运行中追加的用户指导，便于前端回放和本地故障复盘。
- `run.completed`：状态变为 `completed`，记录完成时间、最终摘要、变更文件和验证状态。
- `run.failed`：状态变为 `failed`，记录失败消息。
- `run.canceled`：状态变为 `canceled`，记录取消原因。
- `verification.completed`：更新最终验证状态。

`summary.json` 还记录 `lastSeq`、`eventCount` 和 `updatedAtUnixMs`。`events.jsonl` 是事实来源：如果进程在写入 event 后、更新 summary 前崩溃，或 summary 文件缺失/半写入损坏，`RunLogStore::load_run_summary` 和 `list_run_summaries` 会从完整 `events.jsonl` 重放并修复 `summary.json`，避免 run log 因 summary 落后一拍而永久不可追加。

RPC 层提供两个读取入口：`agent.resume` 用于恢复 run 并重放事件 notification；只读历史分页使用 `agent.loadRunEvents`，按 `beforeSeq` / `limit` 直接返回 event envelope，不重新发送 live notification，也不触发旧审批副作用。VS Code Sidebar 向上滚动历史时走 `agent.loadRunEvents` 从 workspace run log 读取更早事件页。

## 事件格式

当前内部事件使用 JSONL，每行一条 JSON：

```json
{
  "seq": 1,
  "timeUnixMs": 1770000000000,
  "type": "run.started",
  "runId": "run_01",
  "turnId": "turn_01",
  "payload": {}
}
```

说明：

- `seq` 从 1 开始，读取时要求连续；发现缺口或乱序会显式失败。
- `timeUnixMs` 是 UNIX epoch 毫秒。`crates/agent-rpc` 在转换 JSON-RPC 事件时生成 UTC `time` 字符串。
- `type` 使用 `docs/json-rpc-protocol.md` 中的事件名，例如 `run.started`、`assistant.delta`、`tool.completed`。
- `payload` 当前是 `serde_json::Value`，具体 schema 后续会和 JSON-RPC 协议、TypeScript 协议包对齐。

编辑重发不会修改或删除旧 JSONL 行。前端通过 `agent.sendTurn.supersedes` 把被覆盖消息的 timeline `messageId` 和可选 `turnId` 写入新 `turn.started.payload.supersedes`；`agent.resume` 回放时同一 payload 原样返回，VS Code/TUI 可以隐藏或标记被覆盖的用户消息，同时调试工具仍可从旧 `turn.started.userTask` 查看原始输入。

## 路径与标识符规则

- workspace root 必须是已经存在的目录。
- state dir 必须是 workspace-relative path；绝对路径和 `..` 会失败。
- `runId` 和 `turnId` 只能包含 ASCII 字母、数字、`_` 和 `-`。
- event type 只能包含 ASCII 字母、数字、`.`、`_` 和 `-`。

## 脱敏与截断规则

写入事件前，Run Log 会递归处理 `payload`：

- 以下字段名会整体替换为 `<redacted>`：`apiKey`、`authorization`、`password`、`secret`、`token`、`accessToken`、`refreshToken`、`credential`、`privateKey` 等。
- 字符串中的明显 `sk-...` 形态密钥片段会替换为 `<redacted>`。
- 非敏感统计字段不会因为包含 `Tokens` 后缀而被误删，例如 `cacheHitTokens`。
- 单个字符串默认最多保留 16 KiB，单个数组默认最多保留 256 项。超出后保留确定性前缀，并在 payload 顶层写入 `runLogTruncation`。
- `runLogTruncation` 是数组，每项包含 `path`、`reason`、`original` 和 `stored`。因此前端能区分字段不存在、字段为空字符串/空数组，以及字段因大小限制被截断。

工具结果进入模型消息和 Run Log 前都会复用同一套脱敏/截断函数；CLI verification 输出也通过工具结果结构写入，因此与 `shell`、`git_diff`、`read_file` 等工具共享边界。后续导出长期审计包前仍应再做一次独立敏感信息扫描。

## 当前测试覆盖

- 追加事件并按 `seq` 读取。
- 重新打开 run 后从正确的下一条 `seq` 继续。
- 拒绝不安全的 run id 和 state dir。
- 读取时发现序列缺口会失败。
- 写入前脱敏敏感字段和明显密钥片段。
- malformed tool-call arguments 会写入 run-scoped 诊断文件，并在 `run.failed.diagnosticFile` 暴露本地路径。
- run-scoped payload 文件支持 chunk append 和读取，用于 `apply_patch.payloadRef` 这类大参数引用；chunk 追加不触碰 workspace 文件。
- 编辑重发的 `turn.started.payload.supersedes` 会随 run log 保存；RPC/VS Code 测试覆盖同一 run 内新 turn 覆盖旧用户消息且 resume 后可重建隐藏集合。
- 超长字符串和数组会被截断，并记录 `runLogTruncation` 元数据。
- `SerializedRunLog` 多线程 clone 并发追加时，仍生成连续 `seq`，并可被重新打开为正确的下一条序号。
- summary metadata 随事件追加更新，并可按最近更新时间列出。

## 后续增强

- Phase 2c 已增加独立 `provider.completed` 事件，记录 provider usage、cache hit/miss、duration 和 streaming 摘要；Phase 2d 已补统一日志体积控制。
- 扩展 Agent Turn Loop 接入，自动记录 patch proposal、验证命令、取消和恢复事件。
- 增加事件 payload 的强类型 schema，并与 `docs/json-rpc-protocol.md` 和 `packages/protocol` 做兼容性测试。
- 增加日志轮转或分片策略，防止长时间运行和高频 streaming 事件让单个 `events.jsonl` 过大。
- 增加 run export 审计包，导出前再次做敏感信息扫描。
