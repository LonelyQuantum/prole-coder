# 总体架构

状态：草案，Phase 1 Agent Core MVP、Phase 2 Context Capsule 核心和 Phase 3 VS Code 插件核心体验已完成。

`ProleCoder` 分为 Rust 核心和 TypeScript 前端/共享包。

```text
CLI/TUI                 VS Code Extension
   |                           |
   +----------- JSON-RPC ------+
               |
        Agent RPC Server
               |
          Agent Core
               |
   +-----------+-----------+
   |           |           |
Context     Tools      Providers
Builder   Registry    DeepSeek API
```

## 目标

- CLI、TUI 和 VS Code 共用同一个 Agent Core。
- UI 层保持轻量，只负责渲染、用户输入、审批提示和编辑器集成。
- 工具执行和审批策略由 Rust 侧统一管理。
- 协议类型显式、版本化、可测试。
- 本地状态可检查、可复现、可审计。

## 工作区布局（Workspace）

Rust workspace：

- `crates/agent-core`：turn loop、上下文构建、工具编排、run log。
- `crates/agent-rpc`：JSON-RPC server、stdio framing 和协议桥接。
- `crates/cli`：命令行入口。
- `crates/tui`：终端 UI 入口。

TypeScript workspace：

- `packages/protocol`：共享 TypeScript 协议类型。
- `vscode/extension`：VS Code 插件实现。

## 本地状态

运行时状态默认保存在 `.prole-coder/`：

- 配置快照
- workspace manifest
- run log
- token 和 cache 使用摘要
- 审批记录

密钥不得写入 run log。

## 当前实现

- Rust workspace、TypeScript workspace、VS Code 插件骨架和共享协议包已建立。
- `agent-core` 已包含 provider adapter、流式解析、streaming tool call delta accumulator、`reasoning_content` 状态机、工具/审批基础类型、协作式取消 token、read/search/apply_patch/shell/git 基础执行层、基础 run log、基础 Context Builder、基础 Agent Turn Loop、async / streaming `TurnProvider` 边界和 `TurnEventSink` 实时事件出口。
- `agent-rpc` 已实现 Run Log 事件到 `agent.event` JSON-RPC notification 的 stdio 桥接，`StdioEventBridge` 可直接作为 `TurnEventSink` 使用；同时已实现 `agent.initialize` / `agent.sendTurn` / `agent.approve` / `agent.reject` / `agent.cancel` / `agent.resume` / `agent.listRuns` 的双向 request loop、全双工 live event queue、真实 `AgentTurnLoopRpcHandler`、单 active run 的 RPC pending approval 等待队列和断连取消。
- CLI 已实现 `run` 最小闭环，能直接调用 Agent Core、通过 DeepSeek streaming wrapper 驱动真实 provider，在 `--json` 模式下随着 run log 写入实时输出 JSON-RPC event，失败时输出 JSON-RPC error response，并支持 stdin/stderr 交互式审批；CLI `rpc` 子命令已能作为 stdio RPC 入口驱动真实 handler；VS Code 插件已接入 RPC server 启动监管、JSON-RPC request client、Sidebar Chat、事件渲染、真实审批回传、Native diff editor patch 预览、Run List / resume 和 Context Capsule 可视化；TUI 已有审批 prompt 状态机但仍未接入完整 ratatui 界面，优先级排在 VS Code 核心体验之后。

## 后续增强

- Phase 4 已完成 VS Code 深度集成、alpha VSIX 打包、FIM/diagnostics 和 extension-host E2E；TUI 后续复用同一 RPC 管线。
- 扩展 `crates/agent-rpc`，支持多 active run、输出节流和更细的事件 payload schema。
- 明确 `.prole-coder/` 本地状态的目录结构、版本迁移策略和脱敏规则。
- 增加端到端测试，覆盖 CLI/TUI/VS Code 对同一任务产生一致 run log 的能力。
