# 编辑器插件（VS Code Extension）

状态：Phase 3 VS Code 插件核心体验已完成；Phase 4 VS Code 深度集成已完成 14 项深度集成能力；Phase 5 VS Code Codex-like UX 与开发工作流进行中。基础命令、RPC server 启动监管、初始化握手、JSON-RPC request client、VS Code/protocol TypeScript 类型共享、RPC/commands 边界测试、Sidebar Chat 事件渲染、Chat 输入发送真实 turn、真实审批回传、共享 RPC 全双工事件管线、命令风险动态升级展示、Native diff editor patch 预览、Run List / resume、Context Capsule 可视化、VSIX alpha 打包、extension-host E2E、原生 `@prole` Chat Participant、简化审批 UX、自动上下文压缩、`ProleCoder` Output Channel 错误诊断、API key/model 配置、统一 redaction、Git 工作流、Sidebar 连续会话、Run 删除、折叠事件 UX、结构化 provider 配置错误恢复，以及 P5-14 真实试用回归修复包均已实现；P5-15 真实试用 UX backlog 持续收敛仍未完成。

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
- 使用 `ChatEventTimeline` 把 `assistant.delta`、tool lifecycle、approval、context/provider 和 terminal event 转换为 timeline item；默认对话流只显示 `You` 用户消息、`DeepSeek` 回复和失败/取消错误，tool/provider/context/run completed 等过程事件收敛进默认折叠的 Work log，Work log 摘要在运行中只暴露当前工作状态；可见对话消息使用安全 DOM Markdown 渲染，覆盖标题、列表、引用、代码块、表格、链接、inline code 和 horizontal rule，Work log 和工具输出仍保留纯文本，单条消息渲染失败会回退为纯文本并写入 `Output > ProleCoder`；历史 replay 或 streaming 中的高频 `agent.event` 会合并 snapshot/submission/context 推送，避免连续 `assistant.delta` 触发重复完整 Markdown 重渲染。
- 同一 run/turn 的连续 `assistant.delta` 会合并为一条 assistant 消息，避免流式输出刷屏。
- 提供 prompt 输入、mode 选择和运行中 Cancel 按钮；通过 Webview `submitTurn` 消息调用 typed `RpcServerManager.sendTurn()`，发送时把 Problems 快照转换为 diagnostic attachments，并按协议 attachment 上限优先保留 error；如果当前已 resume/发送过 run，会复用该 `runId` 继续同一会话并由后端递增 `turn_N`；accepted 后等待同一 run 的 terminal event 收口输入状态，Cancel 会调用 typed `RpcServerManager.cancel()`。
- Sidebar 右上角提供齿轮 Settings 入口；composer 常驻 API Key / Model 快捷入口。Enter 和 Send 按钮走同一提交路径，Shift+Enter 保留换行；发送后会先在当前对话中显示本地 pending 用户消息，等待真实 run event 覆盖。
- Run List 支持 `agent.listRuns` / `agent.resume` / `agent.deleteRun`，可回放历史 run、继续多轮会话，也可删除 inactive run。
- 失败状态会在 Sidebar Chat 中显示短消息，并把 sendTurn、Run List refresh/resume/delete/cancel、原生 `@prole` Chat Participant 和 RPC 启动/运行 warning 的完整错误写入 VS Code `Output > ProleCoder`；Sidebar Chat 还会把完整 `agent.event` payload 写入 Output 便于 debug。

`vscode/extension/src/commands.ts` 还提供 `requestApproval`：

- 默认使用 Sidebar 内联审批卡片展示审批摘要。
- 主审批动作只展示 `Approve` / `Reject`；`Approve` 映射为一次性批准，`Reject` 映射为拒绝。
- 最多 5 个 `expectedFiles` 的普通 workspace 代码 `apply_patch` 默认直接执行，不弹出审批卡片；超过阈值的 bulk patch、workspace policy 文件 patch 以及需要审批的 shell / network / destructive 操作仍使用 Sidebar 内联 approval card。`apply_patch` 多 hunk 审批边界保留在 Core/RPC/VS Code 中，供高风险 patch 或显式审批路径复用；持久化批准能力保留在 Core/RPC 策略与队列中，不在主审批 UI 暴露复杂选项。

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
  "prole-coder.rpc.args": ["rpc", "--max-output-tokens", "65536"],
  "prole-coder.provider.model": "deepseek-v4-pro"
}
```

开发时如果本机尚未安装 `prole` 可执行文件，可以把命令设置为 `cargo`，参数设置为：

```json
{
  "prole-coder.rpc.command": "cargo",
  "prole-coder.rpc.args": ["run", "-p", "prole-coder-cli", "--", "rpc", "--max-output-tokens", "65536"]
}
```

这些设置可通过 Sidebar composer 的 Settings 按钮或命令面板 `ProleCoder: Open Settings` 打开；需要手动编辑 JSON 时使用 VS Code `Preferences: Open User Settings (JSON)`，也可以在测试 workspace 的 `.vscode/settings.json` 中写入 workspace 级配置。`prole-coder.rpc.args` 改动后需要重启 RPC server 或 reload Extension Development Host，已启动的子进程不会自动继承新参数。

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
8. 使用 VS Code 原生 diff editor 展示 patch，并为 hunk 级审批预留交互边界。已完成：`PatchDiffPreviewController` 可缓存 `tool.requested` 中的 `apply_patch` unified diff，在需要审批的 patch 路径前打开虚拟 after 文档与 workspace before 文档的原生 diff，并保存 whole-patch 模式下的稳定 hunk boundary；小规模普通 workspace 代码 patch 默认免审批，超过 5 个 `expectedFiles` 的 bulk patch 和 workspace policy 文件 patch 仍进入审批路径。
9. 展示 Run List / resume。已完成：Sidebar Chat 顶部 Run List 调用 `agent.listRuns` 展示最近 run summary，点击历史 run 后调用 `agent.resume`，清空当前事件视图并消费 replay 的 `agent.event`。
10. 展示 Context Capsule 可视化。已完成：Sidebar Chat 消费 `context.built` metadata，展示三层 token 分布、input/stable budget、cache/estimator 摘要、included/omitted sources 和 manifest 摘要。

Phase 3 P0 验收标准：

- `agent.sendTurn` 创建 run 后返回 accepted，不等待 `assistant.delta`、审批或 terminal event。
- 同一 run 的 live `agent.event` notification 按 Run Log `seq` 顺序输出。
- `agent.resume` 从指定 `replayFromSeq` 回放事件，且回放结果与 live notification 使用相同 envelope。
- stdin EOF、writer BrokenPipe 或插件停用会取消 active run；run log 最终出现 `run.canceled` 或已有 terminal event。
- Sidebar Chat 能消费 `agent.event` 并展示 `assistant.delta`、tool lifecycle 和 terminal event。已完成首版事件渲染。
- Chat 输入能发送真实 `agent.sendTurn`，并通过事件流收到最终结果。已完成首版输入发送和事件流收口。
- `tool.approvalRequired` 触发 Sidebar 内联审批卡片，approve/reject 能回传到 `agent.approve` / `agent.reject`。已完成真实 RPC pending queue 接入；最多 5 个 `expectedFiles` 的普通 workspace 代码 `apply_patch` 不触发审批，bulk patch / workspace policy 文件 / selected hunk / `agent.approve.hunks` 继续保留给需要审批的 patch 路径。
- Sidebar Chat 能通过 `agent.listRuns` 展示最近 run，并用 `agent.resume` 回放历史事件。已完成首版 Run List / resume 接入。
- Sidebar Chat 能把 `context.built` 渲染为 Context Capsule 面板，展示 token 分段、来源和 manifest/cache/estimator metadata。已完成首版 Context Capsule 可视化。
- `ProleCoder: Open Settings` 和 Sidebar Settings 按钮能打开 VS Code 设置，并显示 server capability、模型预算、审批策略、RPC command/state；扩展配置不保存 API Key，DeepSeek model ID 作为非敏感配置保存。
- Inline completion 首版通过 `agent.previewFim` 请求 RPC server 的 FIM preview，只有 server capability 明确标记 `supportsFim` 的模型会被使用。

Phase 4 深度集成清单与 `docs/phase-tasks.md` 对齐；实现细节和验收命令以任务索引为准：

1. P4-1：VSIX dry-run packaging smoke。
2. P4-2：`@vscode/test-electron` 最小 harness。
3. P4-3：Provider capability model data contract。
4. P4-4：事件 payload schema 与协议 fixture 对齐。
5. P4-5：RPC 高频事件输出节流与批量发送策略。
6. P4-6：`agent.cancel` 类型化 helper 与 Chat Cancel UI。
7. P4-7：Problems 面板诊断进入 Context Builder。
8. P4-8：Terminal command approval。
9. P4-9：审批持久化存储。
10. P4-10：provider、model、预算、审批策略和 RPC 命令配置界面。
11. P4-11：真实 hunk 级 patch 审批。
12. P4-12：FIM completion preview。
13. P4-13：VSIX alpha / pre-release 打包与安装说明。
14. P4-14：补齐 end-to-end 集成测试覆盖。

Phase 5 Codex-like UX 与开发工作流清单与 `docs/phase-tasks.md` 对齐；复杂项在任务索引里继续拆子项：

1. P5-1：原生 Chat 入口。
2. P5-2：简化审批。
3. P5-3：自动上下文压缩。
4. P5-4：UX 收敛测试与打包验收。
5. P5-5：VS Code Output Channel 错误诊断。
6. P5-6：DeepSeek API key SecretStorage、model selector 与 provider status。
7. P5-7：统一 redaction 与 API key 错误恢复 UX。
8. P5-8：Git context 只读采集与大 diff attachment 管线。
9. P5-9：Generate Commit Message。
10. P5-10：Generate PR Description。
11. P5-11：Phase 5 UX 工作流验收。
12. P5-12：Sidebar 连续会话、Run 删除与折叠事件 UX。
13. P5-13：结构化 provider 配置错误码与恢复动作。
14. P5-14：真实试用回归修复包。
15. P5-15：真实试用 UX backlog 持续收敛。

在这些能力稳定前，不在插件侧重复实现 context builder、tool execution 或 provider 调用。

## 后续增强

- 支持多 workspace folder：每个 workspace root 对应一个 RPC server 或明确选择 active workspace。
- 支持多 active run 与多个前端订阅同一 run 的事件流。
- 扩展 Native diff editor hunk 审批到更复杂的编辑器 diff 场景。
- 增加更细的 replay 标记与历史事件筛选语义。
