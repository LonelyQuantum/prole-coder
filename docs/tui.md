# 终端界面（TUI）

状态：草案，保留为正式前端但优先级排在 VS Code 核心体验之后，当前归入 Phase 6。

TUI 是 `ProleCoder` 的终端前端。它应支持键盘驱动的代码工作流，同时与 VS Code 插件共享 Agent Core 行为。

## 计划视图

- Chat：对话和流式模型输出。
- Plan：当前计划和步骤状态。
- Diff：文件级和 hunk 级拟议修改。
- Tools：tool call、审批、命令输出和 exit code。
- Context：token 预算、纳入来源和 cache 使用情况。
- Settings：provider、model 和 approval policy。

## 原则

- 工具执行放在 Rust core 中，不放在 TUI view code 中。
- 审批必须显式且可审计。
- 保留 run id 和 resume point。
- 使用确定性的键盘快捷键。

## 后续增强

- 建立 ratatui 应用骨架，包含 Chat、Plan、Diff、Tools、Context 和 Settings 视图。
- 通过 JSON-RPC 事件流驱动 UI，不在 TUI 中重复实现 Agent loop 或工具执行。
- 支持审批弹窗、命令输出查看、patch 预览、hunk 选择和 run resume。审批弹窗必须消费 `tool.approvalRequired`，展示 `toolName`、风险、命令/路径和持久化能力，并通过 `agent.approve` / `agent.reject` 回传决定；审批结果以后续 `tool.approvalResolved` 为事实来源。
- 增加键盘导航、终端尺寸变化和长输出滚动测试。
- 与 VS Code 插件共享同一套事件语义，确保两个前端看到的风险等级、计划状态和验证结果一致。

## 当前实现

`crates/tui::ApprovalPromptModel` 已提供最小审批 prompt 状态机：

- 渲染审批请求摘要，包括 `approvalId`、`toolName`、风险、命令、路径和持久化状态。
- 处理 `y` / `n` / `p` 等输入，输出批准、拒绝或继续等待。
- 将批准/拒绝映射成可发送给 RPC Server 的审批决定，便于后续接入真实 `agent.approve` / `agent.reject` request。

当前还没有 ratatui 界面和真实 RPC 连接；该模型用于先锁定 TUI 审批交互语义，避免后续 UI 实现偏离 CLI 和 VS Code。TUI 将复用 Phase 3 中为 VS Code 打磨稳定的共享 RPC 事件管线、审批模型和 Run Log 展示语义。

下一步：

- 等 VS Code 核心体验和共享 RPC 事件管线稳定后，进入 TUI Phase 6 实现。
- 为 `prole-coder-tui` 增加命令行入口和配置加载。
- 连接 Rust Agent RPC Server 的 stdio request loop，消费 `agent.event` 事件流。
- 把 `ApprovalPromptModel` 接到真实 `tool.approvalRequired`，并把用户决定发送为 `agent.approve` / `agent.reject`。
