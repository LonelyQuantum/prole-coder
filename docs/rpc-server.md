# Agent RPC Server

状态：`0.1.0` Phase 1 基础 stdio 事件桥接、`TurnEventSink` 实时输出桥接、双向 request loop、真实 Turn Loop handler、RPC pending approval 等待队列、审批超时、pending run 取消语义、EOF shutdown 取消、provider/tool 协作式取消信号和 Run Log 写入串行化已实现；Phase 3 已完成 reader/writer 全双工事件队列、`agent.sendTurn` 早返回和 writer failure 断连取消；Phase 4 已完成初始化 capability data contract、事件 payload fixture 和实时 `agent.eventBatch` wire 层批量发送。

Agent RPC Server 是 CLI、TUI、VS Code 插件和 Rust Agent Core 之间的协议边界。它不重新实现工具执行、上下文构建或 turn loop；它负责把前端 request 转换为 Core 调用，把 Core / Run Log 事件转换为 JSON-RPC notification。

## 设计目标

- 使用 newline-delimited JSON-RPC 2.0 over stdio，便于 CLI、TUI 和 VS Code 复用。
- 事件来源以 Run Log 为准，避免 UI 看到的事件和本地审计日志分叉。
- 事件桥接只做协议封装和时间格式转换，不修改 payload 语义。
- 所有输出都是 UTF-8 单行 JSON，便于前端按行读取和恢复。
- 不把 API Key、环境变量或本机敏感路径写入协议层；Run Log 写入前已做基础脱敏和截断，RPC 层后续重点补充输出节流策略。

## 当前实现范围

当前 `crates/agent-rpc` 实现了 stdio 事件桥接和全双工 request loop：

- `RpcMethod`：生成 `agent.initialize`、`agent.event` 等协议方法名。
- `AgentEventEnvelope`：对应 `docs/json-rpc-protocol.md` 中的 server event envelope。
- `JsonRpcRequest<T>` / `JsonRpcResponse<T>` / `JsonRpcErrorResponse`：JSON-RPC 2.0 request/response/error 基础结构。
- `JsonRpcNotification<T>`：JSON-RPC 2.0 notification 基础结构。
- `run_log_event_to_envelope`：把 `RunLogEvent` 转换为前端事件 envelope。
- `run_log_event_to_notification`：把单个 `RunLogEvent` 转换为 `agent.event` notification。
- `run_log_events_to_batch_notification`：把实时队列中同一轮可立即取出的多个 `RunLogEvent` 转换为 `agent.eventBatch` notification。
- `StdioEventBridge<W>`：把一个或多个 Run Log 事件写为 newline-delimited JSON notification，并实现 `TurnEventSink`，可直接接到 `AgentTurnLoop::run_turn_with_event_sink`。
- `AgentRpcRequestHandler`：RPC request loop 与真实 Core 执行逻辑之间的 handler trait，并提供 EOF shutdown hook。
- `AgentTurnLoopRpcHandler<F>`：通过 provider factory 复用 Core `AgentTurnLoop` 的真实 handler。它会在 `agent.sendTurn` 时创建 run log、启动后台 Turn Loop worker，并在创建 run 后立即返回 accepted；live 事件通过有界队列交给 request loop 的单 writer 持续输出。
- `RpcApprovalQueue` / `RpcApprovalPolicy`：在 `tool.approvalRequired` 事件出现时登记 pending approval，并让后台 Turn Loop 在 `ApprovalPolicy::decide` 中等待 `agent.approve` / `agent.reject` / `agent.cancel` 或超时唤醒。
- `SerializedRunLog`：RPC active run 持有共享的同步 run log，worker append 和 `agent.resume` load 通过同一把锁串行化。
- `CancellationToken`：RPC active run 持有一个可克隆 token，并注入 `AgentTurnInput`；`agent.cancel` 会设置 token，让 provider wrapper 和命令类工具协作式停止。
- `AgentRpcServer<H>`：维护初始化状态，解析单行 JSON-RPC request，分发给 handler，并写回 response / error。
- `agent.listRuns`：通过 Run Log summary metadata 返回本地 run 列表，不扫描完整事件日志。
- `run_stdio_request_loop`：使用 reader thread 读取 newline-delimited JSON-RPC message，同时消费 live event queue；所有 response、error、replay event、live `agent.event` / `agent.eventBatch` notification 都经同一个 writer 串行输出。stdin EOF 或 writer failure 会取消 active run 并 flush 收尾事件。

当前 request loop 已支持 `agent.initialize`、`agent.sendTurn`、`agent.approve`、`agent.reject`、`agent.cancel`、`agent.resume` 和 `agent.listRuns` 的基础分发。`AgentTurnLoopRpcHandler` 已实现真实 `agent.sendTurn`、基于 Run Log 的 `agent.resume`、基于 summary metadata 的 `agent.listRuns`、单 active run 的 pending approval 等待队列、pending approval 超时、取消、EOF shutdown 取消和 provider/tool 协作式停止。RPC crate 本身仍不直接绑定 DeepSeek provider 或 fixture provider；具体 provider 由外部 factory 注入，CLI 的 `rpc` 子命令当前提供 DeepSeek / fixture factory。

本机可通过以下命令启动 stdio RPC server：

```powershell
prole rpc
```

测试和前端开发时可使用 `prole rpc --provider fixture --fixture final` 获得不联网的确定性 provider。

VS Code 插件当前已提供基础进程监管：插件激活后会按 `prole-coder.rpc.command` 和 `prole-coder.rpc.args` 启动该 stdio server，发送 `agent.initialize`，把 stdout 中的 `agent.event` / `agent.eventBatch` notification 转发给前端事件 handler，并在进程退出或启动失败时更新状态和提示用户。扩展侧 `RpcServerManager` 已提供 typed `sendTurn`、`approve`、`reject`、`listRuns` 和 `resume` helper；Sidebar Chat 会用 `agent.listRuns` 填充最近 run 列表，并用 `agent.resume` 回放历史事件。

## 数据流

```text
Agent Core / Turn Loop
  -> RunLog.append(...) / append 后触发 TurnEventSink
  -> RunLogEvent
  -> crates/agent-rpc::StdioEventBridge
  -> {"jsonrpc":"2.0","method":"agent.event","params":...}\n
  -> stdout
  -> CLI/TUI/VS Code
```

请求方向的数据流：

```text
stdin line
  -> parse JSON-RPC request
  -> enforce agent.initialize first
  -> deserialize params
  -> AgentRpcRequestHandler
  -> JSON-RPC response
  -> optional agent.event replay
  -> stdout
```

事件 envelope 示例：

```json
{
  "jsonrpc": "2.0",
  "method": "agent.event",
  "params": {
    "seq": 1,
    "time": "1970-01-01T00:00:00.000Z",
    "type": "run.started",
    "runId": "run_01",
    "payload": {
      "mode": "ask"
    }
  }
}
```

## 时间格式

Run Log 内部使用 `timeUnixMs`，RPC 层对外输出 UTC RFC 3339 风格字符串：

```text
YYYY-MM-DDTHH:MM:SS.mmmZ
```

当前实现没有引入额外时间库，而是使用确定性的 UTC civil date 转换。这样能保持 RPC crate 轻量，也避免本地时区影响前端事件排序。

## 与 Run Log 的关系

Run Log 是事实来源：

- `seq` 保持 run 内单调递增。
- `runId` 和 `turnId` 直接来自 `RunLogEvent`。
- `payload` 保持原样传递。
- `timeUnixMs` 只在 RPC 层转换为 `time` 字符串。

RPC 层不负责重新脱敏 payload。当前 Run Log 写入时已经调用基础脱敏和截断规则，并用 `runLogTruncation` 记录边界；后续可继续补充输出节流和更完整的密钥形态识别。

`agent.sendTurn` 创建 run 后返回 accepted；后续 live events 由后台 worker 通过有界队列持续投递给 request loop。request loop 会把当前可立即取出的连续 live events 批量写为 `agent.eventBatch`，单个 live event 仍写为 `agent.event`。`agent.resume` 等 replay 型方法仍可随 response 返回一组历史 `RunLogEvent`，request loop 会先写 JSON-RPC response，再按顺序写 replay `agent.event` notification。这样保持“request 已被接受”和“事件开始抵达”的边界清晰，同时允许长 provider request 期间继续向前端推送事件，且不改变 Run Log `seq` 与 replay 语义。

`AgentTurnLoopRpcHandler` 已不再用拒绝策略模拟审批。`agent.sendTurn` 会启动后台 Turn Loop worker，并立即返回 accepted；worker 通过 `TurnEventSink` 把 `tool.approvalRequired` 等事件写入 Run Log 后同步投递到 live queue。如果需要审批，worker 在内存队列中等待。随后 `agent.approve` / `agent.reject` 会解析对应 `approvalId`、唤醒 worker，并继续输出 `tool.approvalResolved`、工具执行和 run 结束事件。`agent.cancel` 会设置 active run 的 `CancellationToken`，同时取消尚未解析的 pending approval；等待审批时会写入 `tool.approvalResolved(decision="canceled")` 和 `run.canceled`，provider/tool 执行中取消会以 `E_RUN_CANCELED` 写入 `run.canceled`。request loop 读到 EOF 或写 stdout 失败时会触发断连取消；默认 300 秒审批超时会写入 `tool.approvalResolved(decision="expired")` 和 `run.canceled`。

同一个 active run 的 Run Log 由 `SerializedRunLog` 保护：后台 Turn Loop worker 是唯一实际追加者，`agent.resume` 如果读取的是当前 active run，会通过同一个同步句柄 load，而不是直接绕过锁读取磁盘文件。这样能保证前端 replay 看到的 `seq` 总是来自完整事件边界。

这意味着当前 RPC server 已具备真实审批等待、取消、超时、EOF / writer failure 断连取消、协作式 provider/tool 停止语义、命令子进程树清理，以及 `agent.sendTurn` 早返回后的后台 live event streaming/batching。后续增强重点转向多 active run 和更强 sandbox。

## Request Loop 规则

- 空行会被忽略。
- 每行只处理一条 JSON-RPC message，不支持 batch request。
- client notification 没有 `id`，request loop 不返回 response，也不改变初始化状态。
- `agent.initialize` 必须是第一条带 `id` 的 request。
- `agent.initialize` 只能成功一次。
- `protocolVersion` 必须与 `0.1.0` 精确匹配，否则返回 `E_UNSUPPORTED_PROTOCOL`。
- `agent.sendTurn`、`agent.approve`、`agent.reject`、`agent.cancel`、`agent.resume` 和 `agent.listRuns` 必须在初始化成功后调用。
- handler 返回的 `RunLogEvent` 按原顺序写出为 `agent.event` notification。
- stdin 到 EOF 后，request loop 会调用 handler shutdown；stdout 写入失败会触发 disconnect cancel；真实 Turn Loop handler 会取消 active run 并写出收尾事件，或保留已有 terminal event。

基础错误处理已覆盖：

- JSON 解析失败：`-32700`。
- 非 object、版本错误、初始化顺序错误：`-32600`。
- 未支持 method：`-32601`。
- params 反序列化失败：`-32602`。
- 协议不兼容：`-32001`。

## TypeScript 协议

`packages/protocol` 已补充：

- `jsonRpcVersion`
- `agentInitializeMethod`
- `agentSendTurnMethod`
- `agentResumeMethod`
- `agentApproveMethod`
- `agentRejectMethod`
- `agentCancelMethod`
- `agentListRunsMethod`
- `agentEventMethod`
- `JsonRpcRequest<TParams>`
- `JsonRpcResponse<TResult>`
- `JsonRpcErrorResponse<TData>`
- `JsonRpcNotification<TParams>`
- `AgentInitializeParams` / `AgentInitializeResult`
- `SendTurnParams` / `SendTurnResult`
- `ApproveParams` / `ApproveResult`
- `RejectParams` / `RejectResult`
- `CancelParams` / `CancelResult`
- `ResumeParams` / `ResumeResult`
- `ListRunsParams` / `ListRunsResult` / `RpcRunSummary`
- `AgentEventEnvelope<TPayload>`
- `AgentEventNotification<TPayload>`

这让 VS Code 插件和未来 TUI/CLI 前端可以用同一套 TypeScript 类型发送 request、处理 response/error，并消费 Rust RPC 事件。

## 后续实现

- 输出节流：对高频 `assistant.delta` 做批量发送或节流，避免 stdio 前端卡顿。
- 多 active run：扩展 active run、审批队列、取消句柄和事件订阅模型，使多个前端或多个 run 可以并发推进。
- 更强 sandbox：在已完成的进程树清理基础上，按平台补充更严格的执行隔离、权限限制和可观测说明。
