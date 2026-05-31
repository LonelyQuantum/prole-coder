# 智能体核心（Agent Core）

状态：草案，Phase 1 Agent Core MVP 已完成。

Agent Core 是 CLI、TUI 和 VS Code 共用的执行引擎。它负责模型回合、上下文构建、工具执行、审批和 run log。

## 职责

- 构建 Context Capsule。
- 调用 provider adapter。
- 校验模型 tool call。
- 对高风险操作发起审批。
- 执行已批准的工具。
- 记录 run log。
- 向前端输出结构化事件。

## reasoning_content 状态机

思考模式下如果 assistant 消息触发 tool calls，后续请求必须能够完整回传该 assistant 消息的 `reasoning_content`。这条规则由 Agent Core 统一实现，详见 `docs/reasoning-content.md`。

Agent Core 在调用 provider 前应先准备消息：

```text
run-log messages
  -> ReasoningContentStateMachine
  -> provider request messages
```

没有 tool calls 的普通 assistant 消息会剥离 `reasoning_content`；带有 tool calls 的 assistant 消息必须保留非空 `reasoning_content`，否则回合显式失败。

## 回合生命周期

```text
user turn
  -> load workspace state
  -> build context capsule
  -> call model
  -> stream assistant deltas and tool calls
  -> validate tool call arguments
  -> request approval when needed
  -> execute tool
  -> append result to run log
  -> continue until final response
  -> run verification when applicable
```

## 失败规则

当必要输入缺失或无效时，Agent Core 应显式失败：

- tool-call JSON 无效
- 必需上下文无法放入预算
- 审批被拒绝
- 命令执行失败且没有明确下一步
- provider 响应不符合预期的流式结构

Agent Core 不应通过启发式后处理掩盖失败。

## Context Builder

Phase 1 已实现基础 Context Builder，详见 `docs/context-capsule.md`。它能从用户任务、项目规则、git 状态、文件、工具结果和计划等片段生成稳定排序的上下文输入，并输出 token 预算报告。

当前 token 统计通过 `TokenEstimator` trait 接入，默认使用 `utf8_bytes` 估算器，不是 DeepSeek tokenizer 的精确 token 数；Phase 2b 已提供 `CalibratedEstimator`，基于 provider usage 样本拟合但仍报告 `exact=false`。Context Builder 已接入基础 Agent Turn Loop，并会写入 `context.built` run log 事件；基础 RPC 事件桥接已能把该事件转换为 JSON-RPC notification，`TurnEventSink` 已能在事件写入后立即输出，RPC request loop 和真实 Turn Loop handler 已接入。

Phase 2a/2b/2c 已把基础 builder 升级为结构化 `ContextCapsule`：先构建可审计的 sections、sources 和 token report，再由 `context_capsule.v1` deterministic renderer 按 `CachePlacement::{StablePrefix, DynamicPrelude, TurnSuffix}` 生成 provider 输入。现阶段 `content` 是兼容别名，始终等于 `rendered`；Turn Loop 已自动生成 workspace manifest summary 并放入 `StablePrefix`；`context.built` 会输出 `stablePrefixHash`、稳定前缀预算和 estimator metadata。`agent.sendTurn.attachments` 已接入 file、selection、explicit_content 和 diagnostic；provider usage/cache/stream 摘要通过独立 `provider.completed` 事件进入 run log。

## 本地工具执行

Phase 1 已实现 `WorkspaceToolExecutor`，作为 workspace_manifest/read/search/apply_patch/shell/git 工具的基础执行层。它负责 workspace 路径解析、敏感路径拒绝、命令超时和结构化工具结果。详细设计见 `docs/tool-system.md`。

当前执行层已接入基础 Agent Turn Loop，可以跑通“模型请求工具 -> 请求审批 -> 记录审批决定 -> 执行工具 -> 写入 run log -> 继续下一轮模型调用”的 fake provider 集成测试。RPC handler 已能在 `tool.approvalRequired` 处复用 session/workspace 持久批准，或等待 `agent.approve` / `agent.reject` / `agent.cancel` / 审批超时，并能通过 `CancellationToken` 协作式取消 provider request 和命令类工具。Phase 2d 已加入 tool call JSON Schema 预校验：模型 arguments 会先解析为 `serde_json::Value` 并按工具注册表 schema 校验，再进入 Rust typed deserialization、审批和执行。Phase 3 已加入 shell 命令风险分类器，在审批前识别依赖安装、网络访问、远程 git、删除、reset 和发布等高风险操作并升级风险；Phase 4 已让 shell 审批 payload 携带命令、cwd 和上一条 shell 输出摘要。命令类工具取消或超时时会清理子进程树。尚未完成的是更强 sandbox。

## Run Log

Phase 1 已实现基础 Run Log 存储层，详见 `docs/run-log.md`。它提供 workspace 内 `.prole-coder/runs/<runId>/events.jsonl` 追加写入、按序读取、序列校验和基础脱敏。

当前 Run Log 已接入基础 Agent Turn Loop，会记录 user turn、context、provider 请求摘要、工具请求、审批请求、审批决定、工具结果和 run 完成/失败事件。CLI `run` 已在回合成功后写入 `verification.started` / `verification.completed` 事件，并对验证输出做脱敏和截断；工具结果、verification 输出和 provider 相关 payload 都经过 Run Log 的统一 `sanitize_payload` 入口，超长字符串/数组会在 `runLogTruncation` 中记录边界。`RunLog` 是单 writer 句柄；Agent Core 另外提供 `RunLogWriter` trait 和 `SerializedRunLog`，RPC active run 使用同步包装串行化同一 run 的 append/load。每个 run 还会维护 `summary.json`，供 `agent.listRuns` 在不扫描完整 JSONL 的情况下读取标题、状态、时间、事件数、最终摘要、变更文件和验证状态。

## Agent Turn Loop

Phase 1 已实现基础 Agent Turn Loop，详见 `docs/turn-loop.md`。当前编排层可以用 fake provider 跑通 Context Builder、`ReasoningContentStateMachine`、工具请求、审批、工具执行、脱敏工具结果、Run Log 写入和继续 provider 请求。

当前 Turn Loop 已改为 async / streaming provider 边界：`TurnProvider::complete_stream` 返回 `TurnProviderEvent` 流，Turn Loop 会把 content delta 写入 `assistant.delta`，并要求 provider 最终发送唯一的完整 `Completed` 响应。CLI 已通过 fixture provider 和 DeepSeek streaming wrapper 接入该边界；真实 DeepSeek 文本 streaming、tool call delta accumulator 和小型真实仓库 CLI 验收已完成联网验收。`run_turn_with_event_sink` 会把每条成功持久化的 run event 交给实时 sink，CLI `--json` 和 `StdioEventBridge` 已使用该机制；CLI 失败路径也会输出 JSON-RPC error response。Agent RPC request loop 已能分发 `agent.sendTurn` / `agent.approve` / `agent.reject` / `agent.cancel`，`AgentTurnLoopRpcHandler` 已能驱动真实 Core Turn Loop，并通过内存 pending approval 队列等待 RPC 审批；CLI 已有交互式审批。

## Phase 1 验收状态

Phase 1 已通过以下闭环验收：

1. 本地 fixture 端到端 smoke test。
2. 进程级 CLI fixture smoke test。
3. 真实 DeepSeek provider streaming 联网验收。
4. 真实 streaming tool call delta 拼装验收。
5. 小型真实仓库 CLI 验收：通过 `prole run` 在临时 Rust 仓库上跑通读取、修改、验证和报告。

## 后续增强

- 扩展 RPC active run 管理到多 active run 和跨进程恢复。
- 继续增强 TUI 对真实 RPC pending approval 队列的接入，复用同一协议和审批模型。
- 实现更强 sandbox；命令风险分类器已能区分普通测试命令、网络访问、删除、reset、发布等高风险操作，命令子进程树清理也已完成。
- 扩展 DeepSeek cache hit/miss 手动样本，在大上下文重复前缀场景下记录更清晰的 live 验收过程。
- 扩展 `crates/agent-rpc` 的 client 断连取消和多 active run 管理，供 CLI/TUI/VS Code 共享。
