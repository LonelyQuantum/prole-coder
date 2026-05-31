# 编辑器插件（VS Code Extension）

状态：Phase 3 VS Code 插件核心体验已完成；Phase 4 VS Code 深度集成已完成，包含原 14 项深度集成能力以及 P4-15 到 P4-18 的 Codex-like 原生 Chat UX 收敛。基础命令、审批弹窗 adapter、RPC server 启动监管、初始化握手、JSON-RPC request client、VS Code/protocol TypeScript 类型共享、RPC/commands 边界测试、Sidebar Chat 事件渲染、Chat 输入发送真实 turn、真实审批回传、共享 RPC 全双工事件管线、命令风险动态升级展示、Native diff editor patch 预览、Run List / resume、Context Capsule 可视化、VSIX alpha 打包、extension-host E2E、原生 `@prole` Chat Participant、简化审批 UX 和自动上下文压缩均已实现。

VS Code 插件是 `ProleCoder` 的一等前端。它必须通过 JSON-RPC server 复用 Rust Agent Core，而不是在 TypeScript 侧重新实现 agent loop、context builder、provider 调用或 tool execution。

## 职责

- 启动并监管 Rust Agent RPC Server。
- 渲染 chat 和 run events。
- 展示计划、tool call、审批请求和命令输出摘要，并通过 `agent.approve` / `agent.reject` / `agent.cancel` 回传用户决定。
- 使用 VS Code 原生 diff editor 展示 patch。
- 从 Problems 面板读取 diagnostics。
- 尊重 Workspace Trust。
- 暴露 provider、model、RPC 命令和审批策略设置。

## 非职责

插件不实现自己的 Agent loop、context builder、tool execution engine 或 provider adapter。插件只是前端和进程监管层，事实来源仍是 Rust RPC server 与 Run Log。

## 当前实现

`vscode/extension/src/rpcServer.ts` 提供 `RpcServerManager`：

- 通过可配置命令启动 Rust RPC server，默认命令为 `prole`，默认参数为 `rpc`。
- 启动后立即发送 `agent.initialize`，携带 `protocolVersion`、`client.frontend = "vscode"`、`workspaceRoot` 和 `workspaceTrusted`。
- 按行解析 stdout 上的 JSON-RPC response / notification。
- 把 `agent.event` notification 转发给注册的事件 handler。
- 通过 `sendRequest()` 发送 JSON-RPC request，并按 request id 管理 pending response。
- 提供 typed `sendTurn()`、`cancel()`、`approve()`、`reject()`、`listRuns()` 和 `resume()` helper，避免 UI 层直接拼常用 JSON-RPC method string。
- 把 JSON-RPC error response 转换为 `RpcRequestError`，保留 `code` 和 `data`。
- server 停止、退出或出错时，会拒绝尚未完成的 pending request。
- 记录 stderr 尾部，供后续错误提示和诊断使用。
- 从 `@prole-coder/protocol` 复用 `AgentEventEnvelope` 类型，避免 extension 本地重复定义事件 envelope。
- 如果 server 在 ready 后意外退出，状态进入 `failed` 并提示用户。
- 插件 dispose 时关闭 stdin 并 kill 子进程。
- 未受信任 workspace 不会启动 server。

`vscode/extension/src/commands.ts` 当前注册 `prole-coder.openChat`：

- 如果没有 workspace，则提示先打开 trusted workspace。
- 如果有 RPC manager，则优先打开 VS Code 原生 Chat 侧栏并填入 `@prole`，同时静默启动或复用 RPC server；启动失败时提示原因。

`vscode/extension/src/chatView.ts` 当前注册 `prole-coder.chat` Webview view：

- 在 Activity Bar 暴露 ProleCoder view container 和 Chat view。
- 通过 `RpcServerManager.onEvent()` 订阅 live `agent.event`。
- 使用 `ChatEventTimeline` 把 `assistant.delta`、tool lifecycle、approval、context/provider 和 terminal event 转换为 timeline item。
- 同一 run/turn 的连续 `assistant.delta` 会合并为一条 assistant 消息，避免流式输出刷屏。
- 提供 prompt 输入、mode 选择和运行中 Cancel 按钮；通过 Webview `submitTurn` 消息调用 typed `RpcServerManager.sendTurn()`，发送时把 Problems 快照转换为 diagnostic attachments，并按协议 attachment 上限优先保留 error；accepted 后等待同一 run 的 terminal event 收口输入状态，Cancel 会调用 typed `RpcServerManager.cancel()`。

`vscode/extension/src/commands.ts` 还提供 `requestApproval`：

- 使用 VS Code modal warning 展示审批摘要。
- 主审批弹窗只展示 `Approve` / `Reject`；`Approve` 映射为一次性批准，关闭弹窗映射为拒绝。
- `apply_patch` 多 hunk 审批继续提供 `Select Hunks` quick pick，持久化批准能力保留在 Core/RPC 策略与队列中，不在主弹窗暴露复杂选项。

`vscode/extension/src/approvalFlow.ts` 当前接入真实 RPC pending approval：

- 订阅 `RpcServerManager.onEvent()`，只处理 `tool.approvalRequired`。
- 校验 approval payload 的 `approvalId`、`toolCallId`、`toolName`、`risk`、`title`、`detail`、`persistable`、`command`、`cwd`、`outputSummary` 和 `paths`。
- 复用 `requestApproval` 打开 VS Code modal，并把 approve/reject 结果发送为 typed `RpcServerManager.approve()` / `reject()`。
- 记录已处理的 approvalId，避免重复事件触发重复弹窗。

## 配置

```json
{
  "prole-coder.rpc.autoStart": true,
  "prole-coder.rpc.command": "prole",
  "prole-coder.rpc.args": ["rpc"]
}
```

开发时如果本机尚未安装 `prole` 可执行文件，可以把命令设置为 `cargo`，参数设置为：

```json
{
  "prole-coder.rpc.command": "cargo",
  "prole-coder.rpc.args": ["run", "-p", "prole-coder-cli", "--", "rpc"]
}
```

配置不保存 API Key。DeepSeek API Key 仍应由 Rust CLI/RPC server 按既有规则从环境变量或被忽略的本地 `.secrets/` 文件读取。

## MVP 分层

短期目标是让 VS Code 插件成为 Agent Core 的薄前端，而不是追赶成熟通用插件的全部功能。

Agent Core MVP 只要求 Rust Core / RPC server 提供稳定协议和事件流；VS Code 插件工作从 Phase 3 开始成为主要交付物。TUI 继续保留，但排在 VS Code 核心体验之后。

Phase 3 P0 顺序：

1. 启动并监管 Rust Agent RPC Server。已完成基础实现。
2. 稳定共享 RPC 全双工事件管线。已完成：`agent.sendTurn` 早返回、后台持续推送事件，并在断连时取消 active run。
3. 渲染 `agent.event` 事件流。已完成 Sidebar Chat 首版，能消费 manager 转发的事件。
4. 支持文本输入并通过 `agent.sendTurn` 发送真实 turn。已完成首版 Sidebar Chat 输入发送。
5. 通过 JSON-RPC request client 回传用户动作。已完成 approval approve/reject 回传。
6. 展示审批请求和命令输出摘要。已完成首版 `tool.approvalRequired` modal 接入真实 RPC pending queue。
7. 接入命令风险分类器输出，在审批 UI 中展示动态升级后的风险等级和原因。已完成：approval modal 和 Sidebar Chat 时间线都会展示 `riskReasons`。
8. 使用 VS Code 原生 diff editor 展示 patch，并为 hunk 级审批预留交互边界。已完成：`PatchDiffPreviewController` 缓存 `tool.requested` 中的 `apply_patch` unified diff，在审批 modal 前打开虚拟 after 文档与 workspace before 文档的原生 diff，并保存 whole-patch 模式下的稳定 hunk boundary。
9. 展示 Run List / resume。已完成：Sidebar Chat 顶部 Run List 调用 `agent.listRuns` 展示最近 run summary，点击历史 run 后调用 `agent.resume`，清空当前事件视图并消费 replay 的 `agent.event`。
10. 展示 Context Capsule 可视化。已完成：Sidebar Chat 消费 `context.built` metadata，展示三层 token 分布、input/stable budget、cache/estimator 摘要、included/omitted sources 和 manifest 摘要。

Phase 3 P0 验收标准：

- `agent.sendTurn` 创建 run 后返回 accepted，不等待 `assistant.delta`、审批或 terminal event。
- 同一 run 的 live `agent.event` notification 按 Run Log `seq` 顺序输出。
- `agent.resume` 从指定 `replayFromSeq` 回放事件，且回放结果与 live notification 使用相同 envelope。
- stdin EOF、writer BrokenPipe 或插件停用会取消 active run；run log 最终出现 `run.canceled` 或已有 terminal event。
- Sidebar Chat 能消费 `agent.event` 并展示 `assistant.delta`、tool lifecycle 和 terminal event。已完成首版事件渲染。
- Chat 输入能发送真实 `agent.sendTurn`，并通过事件流收到最终结果。已完成首版输入发送和事件流收口。
- `tool.approvalRequired` 触发 VS Code modal，approve/reject 能回传到 `agent.approve` / `agent.reject`。已完成真实 RPC pending queue 接入；`apply_patch` 首版支持 selected hunk quick pick 并通过 `agent.approve.hunks` 回传。
- Sidebar Chat 能通过 `agent.listRuns` 展示最近 run，并用 `agent.resume` 回放历史事件。已完成首版 Run List / resume 接入。
- Sidebar Chat 能把 `context.built` 渲染为 Context Capsule 面板，展示 token 分段、来源和 manifest/cache/estimator metadata。已完成首版 Context Capsule 可视化。
- `ProleCoder: Open Settings` 能打开 VS Code 设置，并显示 server capability、模型预算、审批策略、RPC command/state；扩展配置不保存 API Key。
- Inline completion 首版通过 `agent.previewFim` 请求 RPC server 的 FIM preview，只有 server capability 明确标记 `supportsFim` 的模型会被使用。

Phase 4 深度集成权威清单与 `docs/phase-tasks.md` 对齐：

1. P4-1：VSIX dry-run packaging smoke，已完成：`pnpm run vsix:smoke` 会构建 extension，临时生成 VSIX，检查 `.vscodeignore`、`workspace:*` 运行时边界、media asset、compiled `out/` 和 activationEvents，并清理产物；不标记最终 VSIX 交付完成。
2. P4-2：`@vscode/test-electron` 最小 harness，已完成：`pnpm run vscode:test-electron` 覆盖 activation、trusted workspace、Chat view focus 和命令注册，测试工作区禁用 RPC autoStart。
3. P4-3：Provider capability model data contract，已完成：`agent.initialize.capabilities.provider` 暴露 DeepSeek V4 model capability，首版不引入 heavy trait。
4. P4-4：事件 payload schema 与协议 fixture 对齐，已完成：共享 fixture 覆盖 `provider.requested`、`tool.completed`、`run.completed`，并处理协议版本不匹配提示。
5. P4-5：RPC 高频事件输出节流与批量发送策略，已完成：实时 live event 支持 `agent.eventBatch`，保持 Run Log `seq` 与 replay 语义稳定。
6. P4-6：`agent.cancel` 类型化 helper 与 Chat Cancel UI，已完成：`RpcServerManager.cancel()` 和 Sidebar Chat Cancel 按钮接入真实 RPC。
7. P4-7：通过 diagnostic attachments 读取 Problems 面板诊断并交给 Agent Core，已完成：发送 turn 时采集 Problems 快照，并按协议 attachment 上限裁剪。
8. P4-8：Terminal command approval 展示命令、cwd、风险等级、上一条 shell 输出摘要和持久化语义，已完成：shared protocol payload 和后端策略已支持；P4-16 后主审批弹窗不再暴露持久化选项。
9. P4-9：审批持久化存储，已完成：RPC 队列支持 session/workspace 持久批准，并继续禁止 network/destructive 风险持久化。
10. P4-10：provider、model、预算、审批策略和 RPC 命令配置界面，已完成：Open Settings 命令展示 `agent.initialize` 返回的 capability data、RPC command/state 和 API Key 不落 VS Code settings 的边界。
11. P4-11：真实 hunk 级 patch 审批，已完成：`apply_patch` 可选择 hunks，RPC/Core 校验 hunk id 并只应用已批准 hunks，审批事件 payload 已同步 fixture。
12. P4-12：FIM completion preview，已完成：VS Code 原生 inline completion 通过 `agent.previewFim` 获取 preview，模型选择只依赖 server capability。
13. P4-13：VSIX alpha / pre-release 打包与安装说明，已完成：`pnpm run vsix:alpha` 会生成 `target/vsix/prole-coder-vscode-0.1.0-alpha.vsix` 和 `.sha256` 校验和，VSIX manifest 标记为 VS Code pre-release；`docs/release.md` 记录 clean user-data/extensions 目录下的安装验收步骤。
14. P4-14：补齐 end-to-end 集成测试覆盖，已完成：`pnpm run vscode:test-electron` 使用本地 JSON-RPC fixture server 覆盖 Chat sendTurn、Cancel、Problems diagnostics、自动审批回传、Run List / resume，并使用隔离 VS Code profile 避免本机状态影响测试；VSIX 安装后基础交互按 `docs/release.md` 的 clean 环境路径验收。
15. P4-15：原生 Chat 入口，已完成：贡献 `@prole` Chat Participant，并让 `ProleCoder: Open Chat` 优先打开 VS Code Chat 侧栏；普通 Activity Bar Webview 继续承载 Run List、Context Capsule 和更详细事件视图。
16. P4-16：简化审批，已完成：主审批按钮保持 Approve / Reject；多 hunk patch 继续保留 Select Hunks；持久化审批能力仍由 Core/RPC 策略约束，不把复杂策略放进主弹窗。
17. P4-17：自动上下文压缩，已完成：Sidebar Chat 和原生 Chat Participant 会把历史对话/事件摘要压缩为 `explicit_content` attachment，交给 Context Capsule 处理，让连续对话自然承接上下文。
18. P4-18：测试与打包验收，已完成：已覆盖 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`、`pnpm run vscode:test-electron`、`pnpm run vsix:smoke` 和 `pnpm run vsix:alpha`。

在这些能力稳定前，不在插件侧重复实现 context builder、tool execution 或 provider 调用。

## 后续增强

- 支持多 workspace folder：每个 workspace root 对应一个 RPC server 或明确选择 active workspace。
- 支持多 active run 与多个前端订阅同一 run 的事件流。
- 扩展 Native diff editor hunk 审批到更复杂的编辑器 diff 场景。
- 增加更细的 replay 标记与历史事件筛选语义。
