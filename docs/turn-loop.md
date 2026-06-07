# Agent Turn Loop

状态：Phase 1 基础编排、TurnProvider async / streaming 边界、真实 DeepSeek 文本 streaming 联网验收、streaming tool call 增量拼装验证、基础 RPC 事件桥接、双向 request loop、真实 RPC Turn Loop handler、`TurnEventSink` 实时事件输出、CLI 交互式审批、CLI JSON-RPC 错误输出、RPC pending approval 等待队列、审批超时、取消语义、provider/tool 协作式取消信号、provider idle timeout 重试、Run Log 写入串行化、Run summary metadata、tool call JSON Schema 预校验、运行中 steer 注入、workspace-scoped 只读 shell 白名单和未知工具可恢复工具结果已实现；Phase 3 已完成 RPC 全双工事件队列、VS Code Chat/审批/Run List/Context Viz 接入和命令子进程树清理；Phase 4 已将 `provider.requested`、`tool.completed`、`run.completed` 纳入共享事件 payload fixture。TUI 真实 RPC UI 仍在后续阶段。

Agent Turn Loop 是 Agent Core 的回合编排层。它负责把已经实现的 Context Builder、`reasoning_content` 状态机、provider 边界、工具执行、审批和 Run Log 串成同一条可复现事件流。

## 当前实现位置

```text
crates/agent-core/src/turn_loop.rs
```

当前实现提供：

- `AgentTurnLoop`：持有 provider、审批策略、工具执行器、reasoning 状态机和回合配置。
- `AgentTurnLoopConfig`：配置最大输入 token、每次继续审批前的 provider request 窗口、provider no-progress timeout / attempts 和 reasoning 模式。CLI 会把 `--thinking enabled|disabled` 同步映射到 provider thinking 选项与 Turn Loop reasoning 状态机，避免在 thinking disabled 时仍要求工具调用携带 `reasoning_content`。
- `TurnProvider`：异步 streaming provider trait。`complete_stream` 返回 `TurnProviderEvent` 流，provider 可以先发送 `AssistantDelta`，再发送唯一的 `Completed` 响应。
- `TurnProviderEvent`：当前包含 `AssistantDelta` 和 `Completed`。`AssistantDelta` 只用于前端展示和 run log 增量；`Completed` 必须包含完整 content、`reasoning_content` 和 tool calls，供后续 reasoning replay 与工具执行使用。
- `CancellationToken`：协作式取消信号。`AgentTurnInput` 持有 token，Turn Loop 会把它传给 `TurnProviderRequest` 和 `WorkspaceToolExecutor`。
- `TurnSteerQueue`：运行中用户指导队列。RPC/前端可以在 active run 内追加 steer 文本，Turn Loop 会在下一次 provider request 前写入 `turn.steered` 并把该指导作为最新用户运行中指令注入。
- `ApprovalPolicy`：审批策略 trait。策略可以批准、拒绝、取消、过期，或返回策略错误；Turn Loop 会把决定写入 `tool.approvalResolved`。
- `RejectAllApprovalPolicy`：默认拒绝所有需要审批的工具，避免写入和命令被静默执行。
- `AutoApprovePolicy`：测试用策略，用于验证已批准工具的执行路径。
- `AgentTurnInput` / `AgentTurnOutcome`：最小 turn 输入与结果。
- `RunLogWriter`：Turn Loop 的 run log 写入边界，支持直接写 `RunLog`，也支持 RPC 使用 `SerializedRunLog` 串行化跨线程 append/load。
- `TurnEventSink` / `NoopTurnEventSink`：Run Log 事件追加成功后的实时输出出口。默认 `run_turn` 使用 no-op sink；CLI/RPC 可以调用 `run_turn_with_event_sink` 接入 JSON-RPC notification writer。

## 当前回合流程

```text
AgentTurnInput
  -> workspace_manifest auto build when needed
  -> ContextBuilder
  -> run log: context.built
  -> ReasoningContentStateMachine
  -> provider.complete_stream
  -> assistant.delta stream
  -> provider Completed response
  -> assistant final 或 assistant tool_calls
  -> tool.requested
  -> tool.approvalRequired when needed
  -> tool.started
  -> WorkspaceToolExecutor
  -> redacted_tool_result_value
  -> tool.completed
  -> drain queued turn.steered messages
  -> append tool result message
  -> next provider.complete
  -> run.completed
```

工具结果写入 run log 或进入下一轮 prompt 前会通过 `redacted_tool_result_value` 转成已脱敏 JSON。原始工具结果仍由工具执行层返回，便于即时诊断和后续 UI 展示，但 Turn Loop 的持久化与模型回传路径使用脱敏结果。
Turn Loop 默认会向 provider 注入工具使用契约，要求所有工具路径保持 workspace-relative，并要求 `shell` 使用 `cwd` 参数切换工作目录，避免模型生成猜测的绝对路径或当前平台不支持的 shell 语法。Windows 构建中该契约会明确 shell 运行在 Windows PowerShell 5.1 下，不应使用 POSIX-only 路径或 PowerShell 7-only 的 `&&` / `||`；测试和验证命令也不应手动追加 `2>&1` 这类合并输出流的重定向，因为 shell 工具已经分别捕获 stdout/stderr，PowerShell stream merging 可能把 CLIXML/progress 噪声带进 stderr 并造成假失败。

## Run Log 事件

当前基础实现写入以下事件：

- `run.started`
- `turn.started`
- `turn.steered`
- `context.built`
- `provider.requested`
- `provider.retrying`
- `provider.completed`
- `assistant.delta`
- `tool.requested`
- `tool.approvalRequired`
- `tool.approvalResolved`
- `tool.started`
- `tool.completed`
- `run.completed`
- `run.failed`

`provider.requested` 只记录消息数量、iteration 和 reasoning replay 状态，不记录完整模型输入。完整上下文由 `context.built` 的 token/source/section/manifest 报告、`turn.steered` 审计事件和后续工具结果共同复现；更细的 provider request 摘要应在后续 schema 中设计。

Turn Loop 会在 provider 建立 stream 和等待下一段 streaming event 两个边界检测 no-progress timeout。默认 60 秒没有任何 stream 进展时，系统会丢弃当前 provider future/stream，写入 `provider.retrying(reason="provider_idle_timeout", timeoutMs, retriesRemaining)` 并重新发起下一次 provider request；连续 5 次 attempt 都没有返回时，run 会以 `run.failed(code="E_PROVIDER_TIMEOUT")` 收口，payload 记录 `timeoutMs`、`attempts` 和已收到的 partial content/reasoning 字符数。普通 transient stream error 仍使用 `provider.retrying(reason="transient_stream_error")`。

`turn.steered` 记录用户在 active run 期间追加的补充指导。Turn Loop 会在每次 provider request 前 drain 当前队列，并在模型消息中明确声明 steer 是最新用户运行中指令，因此该指导会影响下一次模型调用；如果 run 在收到 steer 后没有再进入 provider request，事件可能不会出现。

provider stream 中的 content delta 会立即写入 `assistant.delta`，payload 包含 `stream: true`。如果 provider 没有发送 content delta，Turn Loop 会在收到 `Completed` 后把完整 final content 作为一次 `assistant.delta` 写入。Provider-private `reasoning_content` delta 不写入 `assistant.delta`，只由 provider 聚合后放入 `Completed.reasoning_content`，供 `ReasoningContentStateMachine` 校验和下一轮 replay。

`Completed.content` 是最终 assistant 消息文本的权威来源，用于 `run.completed.summary` 或 assistant tool-call replay。`assistant.delta` 是展示和 run log 增量事件，不反向推断最终文本；当 provider 已经发送过可见 content delta 时，Turn Loop 不会在 `Completed` 时重复写一份完整 `assistant.delta`。因此 reasoning delta 不进入用户可见 summary，tool call 前的可见文本如果存在，应由 provider 同时保留在最终 `Completed.content` 中。

如果 `provider.completed.finishReason` 为 `length` 且没有 tool calls，Turn Loop 不会把空文本或截断文本当作 `run.completed.summary`；它会把截断 assistant 回合保留在内部消息历史中，并追加一次只要求最终工作总结的用户追问。只有后续 provider 以 `stop` 返回无工具调用的 final content 时才写入 `run.completed`。其他非 `stop` 的无工具最终响应会按 provider error 失败，避免 UI 展示“完成但没有总结”的假终态。

如果 `finishReason=length` 时 provider 已经返回了工具调用列表，Turn Loop 也不会执行该轮工具调用，因为 streaming JSON arguments 可能刚好在输出上限处被截断。此时它会保留该轮可见 assistant 文本，并追加一条恢复提示，要求模型丢弃半截工具参数，重新发出完整 JSON 工具调用或继续简短工作；只有后续非截断响应里的完整工具调用才会进入 schema 校验和执行路径。

Turn Loop 默认允许每个预算窗口最多 50 次 provider request。窗口耗尽时不会直接写入 `E_MAX_MODEL_TURNS` 失败，而是写入 `tool.approvalRequired(toolName="model_turn_budget")`，由前端/CLI 通过同一套 `agent.approve` / `agent.reject` 队列决定是否继续；批准后再开启下一段 provider request 窗口，拒绝、取消或过期才按已有审批错误路径结束当前 run。

DeepSeek streaming tool call delta 在 CLI provider wrapper 内通过 `ChatToolCallAccumulator` 拼装为完整 `ChatToolCall` 后才进入 `Completed.tool_calls`。Turn Loop 不直接处理 provider 私有 delta 形态，只要求 provider 在 `Completed` 中提供完整、可校验、可执行的工具调用列表。如果累计后的 `function.arguments` 不是合法 JSON，Turn Loop 会以 `E_INVALID_TOOL_ARGUMENTS` 失败，并把脱敏后的累计 arguments 写入当前 run 的 `diagnostics/invalid-tool-arguments-<sanitizedToolCallId>-<hash>.json`，同时在 `run.failed.diagnosticFile` 暴露该本地路径。若 arguments 是合法 JSON 但未通过已知工具 schema（例如 `read_file` 传入 `limit`），Turn Loop 会记录失败的 `tool.requested` / `tool.completed`，把 `E_INVALID_TOOL_ARGUMENTS`、schema 错误和纠偏 guidance 作为 tool result 喂回 provider，让模型可按正确参数重试。

`apply_patch` 支持大 payload 引用：`tool.requested.argumentsPreview` 可以只包含 `payloadRef`，Turn Loop 在执行前从当前 run 的 `payloads/` 文件读取完整 diff，校验 `sha256` / `sizeBytes` 后 materialize 为 `unifiedDiff`。materialize 之后仍走同一套 schema 校验、路径安全、hunk metadata 和 patch staging；最多 5 个 `expectedFiles` 的普通 workspace 代码 patch 默认不触发审批，超过阈值或修改 workspace policy 文件会动态要求审批，selected hunk 过滤只在高风险 patch 或显式审批路径存在时启用。chunk 追加阶段不会写 workspace。

如果 provider 请求不存在的工具名，例如 `write_file`，Turn Loop 不会执行任何 workspace 写入，也不会直接把 run 标记失败。它会写入 `tool.requested` 和 `tool.completed(status="failed")`，把 `E_UNKNOWN_TOOL` 作为工具结果返回给 provider，并在结果中列出可用工具和纠偏提示。未知工具参数不会写入 run log，避免整文件内容或敏感文本因为错误工具名被展开；文本修改应改用 `apply_patch`。

`run.started` 记录规范化后的 workspace root，用于本地审计和前端展示当前 run 绑定的工作区。该路径只应进入本地 run log 和本机前端事件流，不应被上传到公开仓库或远程日志。

## 审批边界

`read_file`、`search`、`git_status` 和 `git_diff` 使用静态 `read` 风险，不需要审批。

`apply_patch` 保持 `write` 风险和 workspace/path/sensitive-file 约束，但最多 5 个 `expectedFiles` 的普通 workspace 代码修改默认 `approval=none`，不会写入 `tool.approvalRequired`；超过阈值的 bulk patch 或 `.gitignore` / `.prole-coderignore` patch 会动态要求审批。解析错误、文件集合不匹配和 hunk mismatch 会作为 `tool.completed status=failed` 返回给模型，让模型重新读取文件后重试；这些可恢复错误发生在写盘前，failed result 的 `reversePatch` 为空。

`shell` 当前根据工具定义触发审批。默认策略 `RejectAllApprovalPolicy` 会拒绝需要审批的 shell 执行，Turn Loop 写入 `tool.approvalRequired` 和 `tool.approvalResolved` 后以 `E_APPROVAL_REJECTED` 失败；测试可使用 `AutoApprovePolicy` 验证已批准路径。严格只读且 workspace-scoped 的简单 shell 命令例外：`rg`、`Get-Content` / `gc` / `cat` / `type`、`Select-String`、`Get-ChildItem` / `gci` / `dir`、`Test-Path`、`git diff/status/log/show` 和常见本地工具版本查询可以降为 `read` 并免审批，但版本查询只接受裸命令名加一个版本参数，`.env`、`.secrets`、`.git`、`.agents`、`.codex`、`.prole-coder` 等敏感 workspace 路径仍会排除在白名单外；`rg --replace`、`rg -r` 和组合短参数中包含 `r` 的调用不进入只读白名单。

`shell` 的工具定义仍以 `exec` 作为默认风险，但 Turn Loop 会在审批前调用命令风险分类器。分类器会递归检查 shell 包装器、`$(...)` 和传统反引号子命令；依赖安装、网络访问、远程 git 和发布命令会升级为 `network`；删除、强制 push、`git reset --hard`、`git clean` 等会升级为 `destructive`；包含管道、重定向、变量展开、子命令、绝对路径、父级路径、敏感 workspace 路径或可能写文件/执行外部程序参数的 shell 命令不会进入只读白名单。分类结果会同时写入 `tool.requested` 和 `tool.approvalRequired` 的 `risk` / `riskReasons`，供 CLI、RPC、VS Code 和后续 TUI 使用。

RPC handler 当前提供单 active run 的真实审批等待、运行中 steer、协作式取消和全双工事件输出：当 `tool.approvalRequired` 写入 run log 后，RPC 层会把该请求登记为 pending approval，后台 Turn Loop worker 在 `ApprovalPolicy::decide` 中等待；同一事件也会通过 live event queue 投递给 request loop 的单 writer。前端发送 `agent.approve` 会继续进入 `tool.started` 和工具执行；发送 `agent.reject` 会写入拒绝事件并使当前 run 失败；发送 `agent.steer` 会把补充指导放入 active run 的 `TurnSteerQueue`，下一次 provider request 前写入 `turn.steered` 并作为最新用户运行中指令注入模型消息；发送 `agent.cancel` 会设置 active run 的 `CancellationToken`，等待审批时写入 `tool.approvalResolved(decision="canceled")` 和 `run.canceled`，provider/tool 执行中取消时写入 `run.canceled(code="E_RUN_CANCELED")`；超过默认 300 秒没有决定会写入 `tool.approvalResolved(decision="expired")` 和 `run.canceled`。

RPC active run 的 Run Log 使用 `SerializedRunLog`：后台 Turn Loop worker 追加事件，`agent.resume` 读取 active run 时也通过同一个同步句柄。这样可以保证本地 `events.jsonl`、live notification 和 replay 的 `seq` 边界一致。

## 当前测试覆盖

基础 Turn Loop 测试使用 fake provider 覆盖：

- provider 请求 `read_file`，Turn Loop 执行工具、写入 run log、把 tool result message 回传给下一次 provider，并最终完成 run。
- provider 请求 `shell`，默认审批策略拒绝执行，run 失败且不会写入 `tool.started`。
- provider 请求高风险 `shell` 命令时，Turn Loop 会在审批前升级 `tool.requested` / `tool.approvalRequired` 风险并写入 `riskReasons`；网络和破坏性升级均覆盖 `persistable: false`。
- provider 请求 workspace-scoped 只读 shell 命令时，Turn Loop 会把该 shell 调用降为 `read` 并免审批；含管道、重定向、绝对路径、父级路径、敏感 workspace 路径或写入/外部执行参数的命令仍需审批。常见 `python --version`、`node -v`、`cargo --version` 等版本查询按单参数只读命令处理。
- provider 请求 `apply_patch`，最多 5 个 `expectedFiles` 的普通 workspace 代码 patch 免审批修改文件、记录 `changedFiles` 并完成 run；超过阈值的 bulk patch 或 workspace policy 文件 patch 会触发审批；hunk mismatch 等可恢复 patch 错误会作为 failed tool result 回传并继续模型回合。
- provider 请求未知工具如 `write_file` 时，Turn Loop 会把 `E_UNKNOWN_TOOL` 作为 failed tool result 回传，记录失败工具事件，不写入未知工具参数，也不直接 `run.failed`。
- thinking disabled 配置下，provider 返回无 `reasoning_content` 的工具调用时，Turn Loop 会按非 reasoning replay 路径继续执行工具并完成 run。
- provider 发送多个 streaming content delta，Turn Loop 写入多条 `assistant.delta`，并避免在 `Completed` 时重复写入完整文本。
- provider 建立 stream 或等待下一段 stream event 时如果超过配置的 idle timeout 没有进展，Turn Loop 会写入 `provider.retrying(reason="provider_idle_timeout")` 并重试；连续耗尽 attempts 后写入 `run.failed(code="E_PROVIDER_TIMEOUT")`。
- provider 最终响应以 `finishReason=length` 且没有工具调用结束时，Turn Loop 会自动追问一次最终工作总结，并且只有后续 `stop` 响应才写入 `run.completed.summary`。
- provider 响应以 `finishReason=length` 且携带工具调用列表结束时，Turn Loop 会要求模型重新发出完整工具调用，不会执行可能截断的 partial call。
- provider request 窗口耗尽时，Turn Loop 会发出 `model_turn_budget` continuation approval；批准后继续下一段窗口，不再直接 `E_MAX_MODEL_TURNS` 失败。
- active run 收到 queued steer 后，Turn Loop 会在下一次 provider request 前写入 `turn.steered`，并把该补充指导作为最新用户运行中指令加入消息历史。
- provider stream 或 shell 工具收到 `CancellationToken` 后，Turn Loop 写入 `run.canceled`，并返回 `E_RUN_CANCELED`。
- Turn Loop 每次成功追加 Run Log 事件后，会把同一条事件交给 `TurnEventSink`，sink 看到的事件序列与本地 `events.jsonl` 一致。
- `SerializedRunLog` 并发 append 测试验证多个 clone 同时写同一 run 时仍生成连续 `seq`。
- DeepSeek wrapper 能把 streaming tool call delta 拼成完整工具调用，并在缺少必要 metadata 时失败。
- tool call arguments 会先解析为 JSON，再按工具注册表 JSON Schema 校验，最后进入 typed deserialization；malformed JSON 和非法 `payloadRef` 会返回终止型 `E_INVALID_TOOL_ARGUMENTS`，malformed JSON 还会写入脱敏诊断文件。已知工具的 schema mismatch（未知字段、错误类型、非法空值等）会以失败 tool result 返回 provider，不直接终止 run。

这些测试验证的是模块集成骨架，不需要真实 DeepSeek API Key，也不会联网。真实 tool call delta 形态由 `live_streaming_tool_call_accumulator_smoke_test` 作为手动 opt-in live test 验收。

## 尚未实现

- 多 active run 关联和持久批准存储。
- 更强 sandbox 策略。
- RPC request loop 里的 verification 编排；CLI `run` 已支持用户显式 `--verify`。

## 后续增强

- 增加真实 CLI 工具调用端到端验收，把 tool call accumulator、审批、工具执行、继续请求和最终输出串成完整闭环。
- 将 `TurnProviderEvent` 扩展到 usage/cache summary，并写入 provider summary 事件。
- 将 `provider.requested`、`tool.completed` 和 `run.completed` payload schema 与 `docs/json-rpc-protocol.md` / `packages/protocol` 对齐。
- 扩展取消模型到更强 sandbox 和多 active run 场景。
- 将 `ReasoningContentState::ReplayRequired` 的摘要写入更稳定的 run log schema，并关联 tool call id。
- 增加端到端 smoke test，验证 CLI/RPC 从同一份 run log 重建关键过程。
