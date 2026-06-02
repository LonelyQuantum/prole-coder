# 编辑器插件（VS Code Extension）

状态：Phase 3 VS Code 插件核心体验已完成；Phase 4 VS Code 深度集成已完成 14 项深度集成能力；Phase 5 VS Code Codex-like UX 与开发工作流进行中。基础命令、RPC server 启动监管、初始化握手、JSON-RPC request client、VS Code/protocol TypeScript 类型共享、RPC/commands 边界测试、Sidebar Chat 事件渲染、Chat 输入发送真实 turn、真实审批回传、共享 RPC 全双工事件管线、命令风险动态升级展示、Native diff editor patch 预览、Run List / resume、Context Capsule 可视化、VSIX alpha 打包、extension-host E2E、原生 `@prole` Chat Participant、简化审批 UX、自动上下文压缩、`ProleCoder` Output Channel 错误诊断、API key/model 配置、统一 redaction、Git 工作流、Sidebar 连续会话、Run 删除、折叠事件 UX 和结构化 provider 配置错误恢复均已实现；P5-14 已补充 Sidebar 对话专属视图、内联审批/删除确认、默认对话流、Work log 折叠展示和输入快捷键回归，但持续 UX 测试与体验改进占位仍未完成。

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
- 使用 `ChatEventTimeline` 把 `assistant.delta`、tool lifecycle、approval、context/provider 和 terminal event 转换为 timeline item；默认对话流只显示 `You` 用户消息、`DeepSeek` 回复和失败/取消错误，tool/provider/context/run completed 等过程事件收敛进默认折叠的 Work log，Work log 摘要在运行中只暴露当前工作状态。
- 同一 run/turn 的连续 `assistant.delta` 会合并为一条 assistant 消息，避免流式输出刷屏。
- 提供 prompt 输入、mode 选择和运行中 Cancel 按钮；通过 Webview `submitTurn` 消息调用 typed `RpcServerManager.sendTurn()`，发送时把 Problems 快照转换为 diagnostic attachments，并按协议 attachment 上限优先保留 error；如果当前已 resume/发送过 run，会复用该 `runId` 继续同一会话并由后端递增 `turn_N`；accepted 后等待同一 run 的 terminal event 收口输入状态，Cancel 会调用 typed `RpcServerManager.cancel()`。
- Run List 支持 `agent.listRuns` / `agent.resume` / `agent.deleteRun`，可回放历史 run、继续多轮会话，也可删除 inactive run。
- 失败状态会在 Sidebar Chat 中显示短消息，并把 sendTurn、Run List refresh/resume/delete/cancel、原生 `@prole` Chat Participant 和 RPC 启动/运行 warning 的完整错误写入 VS Code `Output > ProleCoder`；Sidebar Chat 还会把完整 `agent.event` payload 写入 Output 便于 debug。

`vscode/extension/src/commands.ts` 还提供 `requestApproval`：

- 默认使用 Sidebar 内联审批卡片展示审批摘要。
- 主审批动作只展示 `Approve` / `Reject`；`Approve` 映射为一次性批准，`Reject` 映射为拒绝。
- `apply_patch` 多 hunk 审批在内联卡片中提供 hunk checkbox，持久化批准能力保留在 Core/RPC 策略与队列中，不在主审批 UI 暴露复杂选项。

`vscode/extension/src/approvalFlow.ts` 当前接入真实 RPC pending approval：

- 订阅 `RpcServerManager.onEvent()`，只处理 `tool.approvalRequired`。
- 校验 approval payload 的 `approvalId`、`toolCallId`、`toolName`、`risk`、`title`、`detail`、`persistable`、`command`、`cwd`、`outputSummary` 和 `paths`。
- 复用 `ApprovalEventController` 的顺序和去重逻辑，默认通过 `ProleChatViewProvider.requestApproval()` 打开 Sidebar 内联卡片，并把 approve/reject 结果发送为 typed `RpcServerManager.approve()` / `reject()`。
- 记录已处理的 approvalId，避免重复事件触发重复提示。

## 配置

```json
{
  "prole-coder.rpc.autoStart": true,
  "prole-coder.rpc.command": "prole",
  "prole-coder.rpc.args": ["rpc"],
  "prole-coder.provider.model": "deepseek-v4-pro"
}
```

开发时如果本机尚未安装 `prole` 可执行文件，可以把命令设置为 `cargo`，参数设置为：

```json
{
  "prole-coder.rpc.command": "cargo",
  "prole-coder.rpc.args": ["run", "-p", "prole-coder-cli", "--", "rpc"]
}
```

配置不保存 API Key。DeepSeek API Key 由插件命令写入 VS Code SecretStorage 的多 key 管理器，或由 CLI/RPC server 继续按既有规则从环境变量读取；Key 管理器展示 alias 与 masked key，支持添加 key+alias、选择 active key、改 alias 和删除指定 key。DeepSeek model ID 是非敏感配置，可通过 `prole-coder.provider.model` 或 Sidebar 的 Model 按钮选择。

## MVP 分层

短期目标是让 VS Code 插件成为 Agent Core 的薄前端，而不是追赶成熟通用插件的全部功能。

Agent Core MVP 只要求 Rust Core / RPC server 提供稳定协议和事件流；VS Code 插件工作从 Phase 3 开始成为主要交付物。TUI 继续保留，但排在 VS Code 核心体验之后。

Phase 3 P0 顺序：

1. 启动并监管 Rust Agent RPC Server。已完成基础实现。
2. 稳定共享 RPC 全双工事件管线。已完成：`agent.sendTurn` 早返回、后台持续推送事件，并在断连时取消 active run。
3. 渲染 `agent.event` 事件流。已完成 Sidebar Chat 首版，能消费 manager 转发的事件。
4. 支持文本输入并通过 `agent.sendTurn` 发送真实 turn。已完成首版 Sidebar Chat 输入发送。
5. 通过 JSON-RPC request client 回传用户动作。已完成 approval approve/reject 回传。
6. 展示审批请求和命令输出摘要。已完成 `tool.approvalRequired` 接入真实 RPC pending queue；默认 UX 已从系统 modal 收敛为 Sidebar 内联审批卡片。
7. 接入命令风险分类器输出，在审批 UI 中展示动态升级后的风险等级和原因。已完成：approval UI 和 Sidebar Chat 时间线都会展示 `riskReasons`。
8. 使用 VS Code 原生 diff editor 展示 patch，并为 hunk 级审批预留交互边界。已完成：`PatchDiffPreviewController` 缓存 `tool.requested` 中的 `apply_patch` unified diff，在审批提示前打开虚拟 after 文档与 workspace before 文档的原生 diff，并保存 whole-patch 模式下的稳定 hunk boundary。
9. 展示 Run List / resume。已完成：Sidebar Chat 顶部 Run List 调用 `agent.listRuns` 展示最近 run summary，点击历史 run 后调用 `agent.resume`，清空当前事件视图并消费 replay 的 `agent.event`。
10. 展示 Context Capsule 可视化。已完成：Sidebar Chat 消费 `context.built` metadata，展示三层 token 分布、input/stable budget、cache/estimator 摘要、included/omitted sources 和 manifest 摘要。

Phase 3 P0 验收标准：

- `agent.sendTurn` 创建 run 后返回 accepted，不等待 `assistant.delta`、审批或 terminal event。
- 同一 run 的 live `agent.event` notification 按 Run Log `seq` 顺序输出。
- `agent.resume` 从指定 `replayFromSeq` 回放事件，且回放结果与 live notification 使用相同 envelope。
- stdin EOF、writer BrokenPipe 或插件停用会取消 active run；run log 最终出现 `run.canceled` 或已有 terminal event。
- Sidebar Chat 能消费 `agent.event` 并展示 `assistant.delta`、tool lifecycle 和 terminal event。已完成首版事件渲染。
- Chat 输入能发送真实 `agent.sendTurn`，并通过事件流收到最终结果。已完成首版输入发送和事件流收口。
- `tool.approvalRequired` 触发 Sidebar 内联审批卡片，approve/reject 能回传到 `agent.approve` / `agent.reject`。已完成真实 RPC pending queue 接入；`apply_patch` 支持 selected hunk 并通过 `agent.approve.hunks` 回传。
- Sidebar Chat 能通过 `agent.listRuns` 展示最近 run，并用 `agent.resume` 回放历史事件。已完成首版 Run List / resume 接入。
- Sidebar Chat 能把 `context.built` 渲染为 Context Capsule 面板，展示 token 分段、来源和 manifest/cache/estimator metadata。已完成首版 Context Capsule 可视化。
- `ProleCoder: Open Settings` 能打开 VS Code 设置，并显示 server capability、模型预算、审批策略、RPC command/state；扩展配置不保存 API Key，DeepSeek model ID 作为非敏感配置保存。
- Inline completion 首版通过 `agent.previewFim` 请求 RPC server 的 FIM preview，只有 server capability 明确标记 `supportsFim` 的模型会被使用。

Phase 4 深度集成权威清单与 `docs/phase-tasks.md` 对齐：

1. P4-1：VSIX dry-run packaging smoke，已完成：`pnpm run vsix:smoke` 会构建 extension，临时生成 VSIX，检查 `.vscodeignore`、`workspace:*` 运行时边界、media asset、compiled `out/` 和 activationEvents，并清理产物；不标记最终 VSIX 交付完成。
2. P4-2：`@vscode/test-electron` 最小 harness，已完成：`pnpm run vscode:test-electron` 覆盖 activation、trusted workspace、Chat view focus 和命令注册，测试工作区禁用 RPC autoStart。
3. P4-3：Provider capability model data contract，已完成：`agent.initialize.capabilities.provider` 暴露 DeepSeek V4 model capability，首版不引入 heavy trait。
4. P4-4：事件 payload schema 与协议 fixture 对齐，已完成：共享 fixture 覆盖 `provider.requested`、`tool.completed`、`run.completed`，并处理协议版本不匹配提示。
5. P4-5：RPC 高频事件输出节流与批量发送策略，已完成：实时 live event 支持 `agent.eventBatch`，保持 Run Log `seq` 与 replay 语义稳定。
6. P4-6：`agent.cancel` 类型化 helper 与 Chat Cancel UI，已完成：`RpcServerManager.cancel()` 和 Sidebar Chat Cancel 按钮接入真实 RPC。
7. P4-7：通过 diagnostic attachments 读取 Problems 面板诊断并交给 Agent Core，已完成：发送 turn 时采集 Problems 快照，并按协议 attachment 上限裁剪。
8. P4-8：Terminal command approval 展示命令、cwd、风险等级、上一条 shell 输出摘要和持久化语义，已完成：shared protocol payload 和后端策略已支持；P5-2 后主审批 UI 不再暴露持久化选项。
9. P4-9：审批持久化存储，已完成：RPC 队列支持 session/workspace 持久批准，并继续禁止 network/destructive 风险持久化。
10. P4-10：provider、model、预算、审批策略和 RPC 命令配置界面，已完成：Open Settings 命令展示 `agent.initialize` 返回的 capability data、RPC command/state 和 API Key 不落 VS Code settings 的边界。
11. P4-11：真实 hunk 级 patch 审批，已完成：`apply_patch` 可选择 hunks，RPC/Core 校验 hunk id 并只应用已批准 hunks，审批事件 payload 已同步 fixture。
12. P4-12：FIM completion preview，已完成：VS Code 原生 inline completion 通过 `agent.previewFim` 获取 preview，模型选择只依赖 server capability。
13. P4-13：VSIX alpha / pre-release 打包与安装说明，已完成：`pnpm run vsix:alpha` 会生成 `target/vsix/prole-coder-vscode-0.1.0-alpha.vsix` 和 `.sha256` 校验和，VSIX manifest 标记为 VS Code pre-release；`docs/release.md` 记录 clean user-data/extensions 目录下的安装验收步骤。
14. P4-14：补齐 end-to-end 集成测试覆盖，已完成：`pnpm run vscode:test-electron` 使用本地 JSON-RPC fixture server 覆盖 Chat sendTurn、Cancel、Problems diagnostics、自动审批回传、Run List / resume，并使用隔离 VS Code profile 避免本机状态影响测试；VSIX 安装后基础交互按 `docs/release.md` 的 clean 环境路径验收。
Phase 5 Codex-like UX 与开发工作流清单与 `docs/phase-tasks.md` 对齐：

1. P5-1：原生 Chat 入口，已完成：贡献 `@prole` Chat Participant，并让 `ProleCoder: Open Chat` 优先打开 VS Code Chat 侧栏；普通 Activity Bar Webview 继续承载 Run List、Context Capsule 和更详细事件视图。
2. P5-2：简化审批，已完成：主审批按钮保持 Approve / Reject；多 hunk patch 继续保留 hunk 选择边界；持久化审批能力仍由 Core/RPC 策略约束，不把复杂策略放进主审批 UI。
3. P5-3：自动上下文压缩，已完成：Sidebar Chat 和原生 Chat Participant 会把历史对话/事件摘要压缩为 `explicit_content` attachment，交给 Context Capsule 处理，让连续对话自然承接上下文。
4. P5-4：UX 收敛测试与打包验收，已完成：已覆盖 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`、`pnpm run vscode:test-electron`、`pnpm run vsix:smoke` 和 `pnpm run vsix:alpha`。
5. P5-5：VS Code Output Channel 错误诊断，已完成：创建 `ProleCoder` Output Channel，记录 Sidebar Chat、Run List、原生 Chat Participant 和 RPC 启动/运行 warning 的完整错误；activation 层使用统一 notifier 分发日志与 VS Code toast，避免侧边栏短状态截断关键诊断。
6. P5-6：DeepSeek API key SecretStorage、model selector 与 provider status，已完成：插件内配置/清除 key、选择 DeepSeek model 与查看 provider status；API key 配置入口是 SecretStorage 多 key 管理器，列表展示 alias 与 masked key，支持 `+ Add` 添加 key+alias、选择 active key、行内 edit 按钮修改 alias 和 trash 按钮删除指定 key；provider status 同时显示 key 来源/alias 与当前 model；Sidebar composer 常驻 Key/Model 按钮；SecretStorage 优先、process env fallback，RPC child env 继承 `process.env` 后覆盖 active `DEEPSEEK_API_KEY` 与选中的 `DEEPSEEK_MODEL`。
7. P5-7：统一 redaction 与 API key 错误恢复 UX，已完成：notifier/logger 统一脱敏 SecretStorage/env key；缺少 `DEEPSEEK_API_KEY` 时 Sidebar/原生 Chat 自动打开配置入口，Sidebar 错误状态保留 Configure API Key 修复按钮；API key 配置或 model 切换后 idle 状态自动重启 RPC，active run 场景保守提示稍后生效。
8. P5-8：Git context 只读采集与大 diff attachment 管线，已完成：优先使用 VS Code Git API，git CLI 仅作受控 fallback，commit/PR 命令把 diff context 作为 `explicit_content` attachment 进入 Context Capsule 管线。
9. P5-9：Generate Commit Message，已完成：从 staged diff 生成候选 commit message 并写入 Source Control inputBox，不自动 commit；staged 为空时才询问是否使用 unstaged diff。
10. P5-10：Generate PR Description，已完成：根据 upstream/main/master/用户选择的 base、diff/stat 和 commit summary 生成 PR title/body markdown，用带标题的 untitled markdown 预览承载结果，不自动创建 PR。
11. P5-11：Phase 5 UX 工作流验收，已完成：补齐 P5-6 到 P5-10 的测试、VSIX 验证和文档收敛；Git workflow agent 终态事件已补幂等保护，G4 自动 commit / push / create PR 留作后续增强并接入审批模型。
12. P5-12：Sidebar 连续会话、Run 删除与折叠事件 UX，已完成：Sidebar resume 后继续同一 run 发送多轮 turn，Run List 可通过 `agent.deleteRun` 删除 inactive run；tool/provider/request 等过程事件默认折叠，assistant 文本和最终摘要保持可见，完整事件 payload 写入 `Output > ProleCoder`。
13. P5-13：结构化 provider 配置错误码与恢复动作，已完成：DeepSeek 缺少 API key 的 RPC `E_PROVIDER_ERROR` 返回 `data.provider` / `data.configurationError` / `data.recoverableAction`，Sidebar/原生 Chat Participant 依据 recoverable action 展示或自动触发 Configure API Key，不再解析后端英文错误消息；run failed payload 也支持同一恢复动作。
14. P5-14：持续 UX 测试与体验改进占位，未完成：已补齐进入 run 后的 Sidebar 对话专属视图、内联 approval/delete 确认、默认只显示用户消息与 DeepSeek 回复的对话流、默认折叠 Work log、Enter 发送 / Shift+Enter 换行；后续继续根据真实 VS Code 插件试用收集 Runs、Key/Model、审批、Chat、Output 日志和上下文压缩等体验问题，作为 Phase 5 整体完成前的持续验收入口。

在这些能力稳定前，不在插件侧重复实现 context builder、tool execution 或 provider 调用。

## 后续增强

- 支持多 workspace folder：每个 workspace root 对应一个 RPC server 或明确选择 active workspace。
- 支持多 active run 与多个前端订阅同一 run 的事件流。
- 扩展 Native diff editor hunk 审批到更复杂的编辑器 diff 场景。
- 增加更细的 replay 标记与历史事件筛选语义。
