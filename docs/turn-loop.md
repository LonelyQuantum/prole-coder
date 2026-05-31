# Agent Turn Loop

状态：Phase 1 基础编排、TurnProvider async / streaming 边界、真实 DeepSeek 文本 streaming 联网验收、streaming tool call 增量拼装验证、基础 RPC 事件桥接、双向 request loop、真实 RPC Turn Loop handler、`TurnEventSink` 实时事件输出、CLI 交互式审批、CLI JSON-RPC 错误输出、RPC pending approval 等待队列、审批超时、取消语义、provider/tool 协作式取消信号、Run Log 写入串行化、Run summary metadata 和 tool call JSON Schema 预校验已实现；Phase 3 已完成 RPC 全双工事件队列、VS Code Chat/审批/Run List/Context Viz 接入和命令子进程树清理；Phase 4 已将 `provider.requested`、`tool.completed`、`run.completed` 纳入共享事件 payload fixture。TUI 真实 RPC UI 仍在后续阶段。

Agent Turn Loop 是 Agent Core 的回合编排层。它负责把已经实现的 Context Builder、`reasoning_content` 状态机、provider 边界、工具执行、审批和 Run Log 串成同一条可复现事件流。

## 当前实现位置

```text
crates/agent-core/src/turn_loop.rs
```

当前实现提供：

- `AgentTurnLoop`：持有 provider、审批策略、工具执行器、reasoning 状态机和回合配置。
- `AgentTurnLoopConfig`：配置最大输入 token、最大模型子回合数和 reasoning 模式。CLI 会把 `--thinking enabled|disabled` 同步映射到 provider thinking 选项与 Turn Loop reasoning 状态机，避免在 thinking disabled 时仍要求工具调用携带 `reasoning_content`。
- `TurnProvider`：异步 streaming provider trait。`complete_stream` 返回 `TurnProviderEvent` 流，provider 可以先发送 `AssistantDelta`，再发送唯一的 `Completed` 响应。
- `TurnProviderEvent`：当前包含 `AssistantDelta` 和 `Completed`。`AssistantDelta` 只用于前端展示和 run log 增量；`Completed` 必须包含完整 content、`reasoning_content` 和 tool calls，供后续 reasoning replay 与工具执行使用。
- `CancellationToken`：协作式取消信号。`AgentTurnInput` 持有 token，Turn Loop 会把它传给 `TurnProviderRequest` 和 `WorkspaceToolExecutor`。
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
  -> append tool result message
  -> next provider.complete
  -> run.completed
```

工具结果写入 run log 或进入下一轮 prompt 前会通过 `redacted_tool_result_value` 转成已脱敏 JSON。原始工具结果仍由工具执行层返回，便于即时诊断和后续 UI 展示，但 Turn Loop 的持久化与模型回传路径使用脱敏结果。

## Run Log 事件

当前基础实现写入以下事件：

- `run.started`
- `turn.started`
- `context.built`
- `provider.requested`
- `assistant.delta`
- `tool.requested`
- `tool.approvalRequired`
- `tool.approvalResolved`
- `tool.started`
- `tool.completed`
- `run.completed`
- `run.failed`

`provider.requested` 只记录消息数量、iteration 和 reasoning replay 状态，不记录完整模型输入。完整上下文由 `context.built` 的 token/source/section/manifest 报告和后续工具结果共同复现；更细的 provider request 摘要应在后续 schema 中设计。

provider stream 中的 content delta 会立即写入 `assistant.delta`，payload 包含 `stream: true`。如果 provider 没有发送 content delta，Turn Loop 会在收到 `Completed` 后把完整 final content 作为一次 `assistant.delta` 写入。Provider-private `reasoning_content` delta 不写入 `assistant.delta`，只由 provider 聚合后放入 `Completed.reasoning_content`，供 `ReasoningContentStateMachine` 校验和下一轮 replay。

`Completed.content` 是最终 assistant 消息文本的权威来源，用于 `run.completed.summary` 或 assistant tool-call replay。`assistant.delta` 是展示和 run log 增量事件，不反向推断最终文本；当 provider 已经发送过可见 content delta 时，Turn Loop 不会在 `Completed` 时重复写一份完整 `assistant.delta`。因此 reasoning delta 不进入用户可见 summary，tool call 前的可见文本如果存在，应由 provider 同时保留在最终 `Completed.content` 中。

DeepSeek streaming tool call delta 在 CLI provider wrapper 内通过 `ChatToolCallAccumulator` 拼装为完整 `ChatToolCall` 后才进入 `Completed.tool_calls`。Turn Loop 不直接处理 provider 私有 delta 形态，只要求 provider 在 `Completed` 中提供完整、可校验、可执行的工具调用列表。

`run.started` 记录规范化后的 workspace root，用于本地审计和前端展示当前 run 绑定的工作区。该路径只应进入本地 run log 和本机前端事件流，不应被上传到公开仓库或远程日志。

## 审批边界

`read_file`、`search`、`git_status` 和 `git_diff` 使用静态 `read` 风险，不需要审批。

`apply_patch` 和 `shell` 当前根据工具定义触发审批：

- 默认策略 `RejectAllApprovalPolicy` 会拒绝执行，Turn Loop 写入 `tool.approvalRequired` 和 `tool.approvalResolved` 后以 `E_APPROVAL_REJECTED` 失败。
- 测试可使用 `AutoApprovePolicy` 验证已批准路径。

`shell` 的工具定义仍以 `exec` 作为最低风险，但 Turn Loop 会在审批前调用命令风险分类器。分类器会递归检查 shell 包装器、`$(...)` 和传统反引号子命令；依赖安装、网络访问、远程 git 和发布命令会升级为 `network`；删除、强制 push、`git reset --hard`、`git clean` 等会升级为 `destructive`。升级结果会同时写入 `tool.requested` 和 `tool.approvalRequired` 的 `risk` / `riskReasons`，供 CLI、RPC、VS Code 和后续 TUI 使用。

RPC handler 当前提供单 active run 的真实审批等待、协作式取消和全双工事件输出：当 `tool.approvalRequired` 写入 run log 后，RPC 层会把该请求登记为 pending approval，后台 Turn Loop worker 在 `ApprovalPolicy::decide` 中等待；同一事件也会通过 live event queue 投递给 request loop 的单 writer。前端发送 `agent.approve` 会继续进入 `tool.started` 和工具执行；发送 `agent.reject` 会写入拒绝事件并使当前 run 失败；发送 `agent.cancel` 会设置 active run 的 `CancellationToken`，等待审批时写入 `tool.approvalResolved(decision="canceled")` 和 `run.canceled`，provider/tool 执行中取消时写入 `run.canceled(code="E_RUN_CANCELED")`；超过默认 300 秒没有决定会写入 `tool.approvalResolved(decision="expired")` 和 `run.canceled`。

RPC active run 的 Run Log 使用 `SerializedRunLog`：后台 Turn Loop worker 追加事件，`agent.resume` 读取 active run 时也通过同一个同步句柄。这样可以保证本地 `events.jsonl`、live notification 和 replay 的 `seq` 边界一致。

## 当前测试覆盖

基础 Turn Loop 测试使用 fake provider 覆盖：

- provider 请求 `read_file`，Turn Loop 执行工具、写入 run log、把 tool result message 回传给下一次 provider，并最终完成 run。
- provider 请求 `shell`，默认审批策略拒绝执行，run 失败且不会写入 `tool.started`。
- provider 请求高风险 `shell` 命令时，Turn Loop 会在审批前升级 `tool.requested` / `tool.approvalRequired` 风险并写入 `riskReasons`；网络和破坏性升级均覆盖 `persistable: false`。
- provider 请求 `apply_patch`，测试审批策略批准后修改文件、记录 `changedFiles`，并完成 run。
- thinking disabled 配置下，provider 返回无 `reasoning_content` 的工具调用时，Turn Loop 会按非 reasoning replay 路径继续执行工具并完成 run。
- provider 发送多个 streaming content delta，Turn Loop 写入多条 `assistant.delta`，并避免在 `Completed` 时重复写入完整文本。
- provider stream 或 shell 工具收到 `CancellationToken` 后，Turn Loop 写入 `run.canceled`，并返回 `E_RUN_CANCELED`。
- Turn Loop 每次成功追加 Run Log 事件后，会把同一条事件交给 `TurnEventSink`，sink 看到的事件序列与本地 `events.jsonl` 一致。
- `SerializedRunLog` 并发 append 测试验证多个 clone 同时写同一 run 时仍生成连续 `seq`。
- DeepSeek wrapper 能把 streaming tool call delta 拼成完整工具调用，并在缺少必要 metadata 时失败。
- tool call arguments 会先按工具注册表 JSON Schema 校验，再进入 typed deserialization；未知字段和错误类型会返回 `E_INVALID_TOOL_ARGUMENTS`。

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
