# JSON-RPC 协议

状态：`0.1.0` 协议版本的已接受草案。

本文档定义 `ProleCoder` 前端与 Rust Agent RPC Server 之间的内部协议。它不是 DeepSeek API 协议。

## 位置

```text
VS Code / TUI / CLI
        |
        | JSON-RPC 2.0 over stdio
        v
Agent RPC Server
        |
        v
Agent Core
```

该协议让前端保持轻量。前端负责渲染状态、收集用户输入、响应审批提示。Agent Core 负责 turn loop、context construction、provider call、tool execution、approval policy 和 run log。

## 传输

初始传输方式是基于 stdio 的 newline-delimited JSON-RPC 2.0：

- UTF-8 JSON。
- 每行一条 JSON-RPC 消息。
- request id 使用字符串。
- 前端向 server 发送 request。
- server 向前端发送 response 和 event notification。

服务端事件使用 JSON-RPC notification，method 固定为 `agent.event`：

```json
{
  "jsonrpc": "2.0",
  "method": "agent.event",
  "params": {
    "seq": 1,
    "time": "2026-05-20T14:00:00Z",
    "type": "run.started",
    "runId": "run_01",
    "payload": {}
  }
}
```

实时高频事件可以使用 `agent.eventBatch` notification 批量发送；Run Log 本身仍以单个 `seq` 事件作为事实来源，`agent.resume` replay 仍按 `agent.event` 重放；只读历史分页使用 `agent.loadRunEvents` 在 response 中返回 event envelope，不重新发送 live notification。
```json
{
  "jsonrpc": "2.0",
  "method": "agent.eventBatch",
  "params": {
    "events": [
      {
        "seq": 2,
        "time": "2026-05-20T14:00:00.001Z",
        "type": "assistant.delta",
        "runId": "run_01",
        "turnId": "turn_01",
        "payload": { "text": "hello" }
      }
    ],
    "firstSeq": 2,
    "lastSeq": 2,
    "count": 1
  }
}
```

## 版本

协议版本为 `0.1.0`。

在 `0.x` 阶段，client 和 server 默认要求精确版本匹配；除非双方在 `agent.initialize` 中显式声明兼容版本。

版本变化规则：

- Patch：只做文档澄清。
- Minor：只新增字段、方法或事件。
- Major 或 pre-1.0 incompatible bump：重命名字段、删除字段、改变语义或改变必需行为。

## 标识符

所有 id 都是不透明字符串：

- `runId`：一次 agent run。
- `turnId`：run 内的一次用户 turn。
- `event seq`：run log 内单调递增的整数。
- `approvalId`：一次审批请求。
- `toolCallId`：一次 tool call。
- `patchId`：一次拟议 patch。
- `verificationId`：一次验证命令。

前端不得从 id 前缀推断语义。

## 路径

- `workspaceRoot` 使用绝对平台路径。
- 事件中的文件路径使用 workspace-relative path，并用 `/` 作为分隔符。
- 工具执行必须把路径解析在 workspace 内；除非工具显式声明例外，并获得审批。

## 通用类型

### ClientInfo

```ts
type FrontendKind = "cli" | "tui" | "vscode";

interface ClientInfo {
  name: string;
  version: string;
  frontend: FrontendKind;
}
```

### Capability Set

```ts
interface ServerCapabilities {
  protocolVersion: "0.1.0";
  supportsRunResume: boolean;
  supportsPatchApproval: boolean;
  supportsPersistentApprovals: boolean;
  supportsEventBatching: boolean;
  supportedRiskLevels: RiskLevel[];
  provider: ProviderCapabilities;
}

interface ProviderCapabilities {
  provider: string;
  defaultModel: string;
  models: ProviderModelCapabilities[];
}

interface ProviderModelCapabilities {
  id: string;
  displayName?: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsToolCalls: boolean;
  supportsToolChoice: boolean;
  supportsFim: boolean;
  supportsStreaming: boolean;
  reportsCacheUsage: boolean;
}
```

### RiskLevel

```ts
type RiskLevel = "read" | "write" | "exec" | "network" | "destructive";
```

### PlanStep

```ts
type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "canceled";

interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  detail?: string;
}
```

### PatchApprovalHunk

```ts
interface PatchApprovalHunk {
  id: string;
  filePath: string;
  fileIndex: number;
  hunkIndex: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section?: string;
}
```

## 方法

### `agent.initialize`

连接到 workspace 并协商能力。

Request：

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "method": "agent.initialize",
  "params": {
    "protocolVersion": "0.1.0",
    "client": {
      "name": "prole-coder-vscode",
      "version": "0.1.0",
      "frontend": "vscode"
    },
    "workspaceRoot": "C:/workspace/prole-coder",
    "workspaceTrusted": true
  }
}
```

Result：

```json
{
  "protocolVersion": "0.1.0",
  "server": {
    "name": "prole-coder-agent-rpc",
    "version": "0.1.0"
  },
  "capabilities": {
    "protocolVersion": "0.1.0",
    "supportsRunResume": true,
    "supportsPatchApproval": true,
    "supportsPersistentApprovals": true,
    "supportsEventBatching": true,
    "supportedRiskLevels": ["read", "write", "exec", "network", "destructive"],
    "provider": {
      "provider": "deepseek",
      "defaultModel": "deepseek-v4-pro",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "displayName": "DeepSeek V4 Pro",
          "contextWindowTokens": 1048576,
          "maxOutputTokens": 393216,
          "supportsThinking": true,
          "supportsToolCalls": true,
          "supportsToolChoice": false,
          "supportsFim": true,
          "supportsStreaming": true,
          "reportsCacheUsage": true
        }
      ]
    }
  },
  "stateDir": ".prole-coder"
}
```

规则：

- `agent.initialize` 必须是第一条 request。
- `agent.initialize` 必须带 `id`。作为 notification 发送时，server 不返回 response，也不会改变初始化状态。
- 如果 `workspaceTrusted` 为 false，则禁用 write、exec、network 和 destructive 工具。
- 协议不匹配时返回 `E_UNSUPPORTED_PROTOCOL`。
- 当前 Rust request loop 已实现初始化顺序检查、协议版本检查和 response/error 写回；真实 workspace trust 工具降级策略会随审批 handler 接入。

### `agent.sendTurn`

发送用户请求。如果省略 `runId`，server 创建新的 run。

Request params：

```ts
interface SendTurnParams {
  runId?: string;
  message: string;
  mode: "plan" | "edit" | "review" | "ask";
  attachments?: TurnAttachment[];
  supersedes?: TurnSupersedes;
}

interface TurnSupersedes {
  messageId: string;
  turnId?: string;
}

interface TurnAttachment {
  kind: "file" | "selection" | "explicit_content" | "diagnostic";
  path?: string;
  range?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  text?: string;
}
```

Result：

```ts
interface SendTurnResult {
  runId: string;
  turnId: string;
  accepted: true;
}
```

Result 返回后，进度通过 `agent.event` notification 持续到达。

当前 Rust request loop 已能解析 `agent.sendTurn` 并分发给 `AgentRpcRequestHandler`。`crates/agent-rpc::AgentTurnLoopRpcHandler` 已能创建 run、选择注入的 provider factory、启动后台 Turn Loop worker，并在创建 run 后立即返回 `accepted`。Run Log 事件会通过独立的 live event queue 发送到 request loop 的单 writer，并持续输出为 `agent.event` notification；遇到审批时，worker 会先检查 session/workspace 持久批准，再在 pending approval 队列中等待 `agent.approve` / `agent.reject` / `agent.cancel`，并在超时时写入取消事件。active run 还可以通过 `agent.steer` 接收运行中的用户补充指导，Turn Loop 会在下一次 provider request 前把它作为最新用户运行中指令注入。如果 request loop 读到 EOF 或 writer 失败，会触发 handler shutdown / disconnect cancel；对于 active run，shutdown 会把未决审批解析为 `decision: "canceled"` 并写入 `run.canceled`，或等待已有 terminal event 收口。

Phase 2c 起，Rust handler 会消费 `attachments` 并转换为 Context Capsule 来源：`file` 由 Core 在工作区内读取，复用工具执行层的路径和敏感目录保护；`selection` / `explicit_content` 由前端提供文本但受数量、大小、重复来源和路径校验限制；`diagnostic` 由 VS Code/TUI 等前端传入结构化诊断文本。VS Code 插件在发送 turn 时会把当前 Problems 快照转换为 diagnostic attachments，并按协议 attachment 上限优先保留 error；Phase 4 起，Sidebar Chat 与原生 `@prole` Chat Participant 会把历史对话/事件摘要压缩为受限长度的 `explicit_content` attachment，并为该自动上下文预留一个 attachment 槽位。Sidebar timeline 来源会在生成自动上下文前先限制单条消息长度，避免极端长 `assistant.delta` 合并内容造成过大的中间文本。当前默认限制是单 turn 最多 32 个 attachment，单个 attachment 文本最多 256 KiB；超过限制会让该 run 以 `run.failed` / `E_INVALID_ATTACHMENT` 结束。

`supersedes` 用于编辑重发。前端可以在同一 run 内发送新 turn 时声明它覆盖了某个历史用户消息的 timeline `messageId`，并可附带原 `turnId`。Server 不会重写或删除旧 run log 事件，而是在新 `turn.started.payload.supersedes` 中追加审计元数据；resume/reload 时前端据此隐藏或标记被覆盖的用户消息，自动上下文压缩也应跳过这些 superseded 用户消息。`messageId` 是前端 timeline item id，不要求符合 `runId` 标识符字符集；Rust RPC handler 只接受非空且不超过 256 bytes 的 `messageId`。`turnId` 如果提供，必须是非空、不超过 128 bytes，且只包含 ASCII 字母、数字、`_` 或 `-`。

### `agent.approve`

批准一个 pending approval request。

```ts
interface ApproveParams {
  approvalId: string;
  persist?: "never" | "session" | "workspace";
  hunks?: {
    approved: string[];
  };
}

interface ApproveResult {
  approvalId: string;
  state: "approved";
  persist: "never" | "session" | "workspace";
  hunks?: {
    approved: string[];
  };
}
```

规则：

- `persist` 默认是 `never`。
- 只有明确标记为 `persistable: true` 的审批类型才能使用 `session` / `workspace` 持久化。
- `network` 和 `destructive` 风险不可持久化，即使客户端发送持久化参数也会被 server 拒绝。
- `hunks.approved` 只用于 `apply_patch` 的 hunk 级批准；必须引用 `tool.approvalRequired.hunks` 中存在的 id，且不能与 `session` / `workspace` 持久化同时使用。
- 批准已过期或未知审批时返回 `E_APPROVAL_NOT_FOUND`。
- 当前 Rust request loop 已能解析 `agent.approve` 并分发给 `AgentRpcRequestHandler`；`AgentTurnLoopRpcHandler` 已能批准当前 active run 的 pending approval，并按需写入 session/workspace 持久批准。后续相同 key 的审批会自动通过并继续输出 `tool.approvalResolved`、后续工具事件和 run 结束事件。hunk 级批准会在 Core 层过滤 `apply_patch` 后只应用已批准 hunks。未知、已使用或已过期的 approval 会返回 `E_APPROVAL_NOT_FOUND`。

### `agent.reject`

拒绝一个 pending approval request。

```ts
interface RejectParams {
  approvalId: string;
  reason?: string;
}

interface RejectResult {
  approvalId: string;
  state: "rejected";
  reason?: string;
}
```

规则：

- Agent Core 将拒绝记录到 run log。
- Agent Core 不得用等价操作绕过拒绝。
- 拒绝后，Agent Core 要么请求新路径，要么继续只读工作，要么停止 run。
- 当前 Rust request loop 已能解析 `agent.reject` 并分发给 `AgentRpcRequestHandler`；`AgentTurnLoopRpcHandler` 已能拒绝当前 active run 的 pending approval，并继续输出 `tool.approvalResolved` 和 `run.failed`。未知、已使用或已过期的 approval 会返回 `E_APPROVAL_NOT_FOUND`。

### `agent.cancel`

取消 active run。

```ts
interface CancelParams {
  runId: string;
  reason?: string;
}

interface CancelResult {
  runId: string;
  state: "canceled";
  reason?: string;
}
```

规则：

- 当前 Rust request loop 已能解析 `agent.cancel` 并分发给 `AgentRpcRequestHandler`。
- Phase 1 实现支持取消 active run。取消会设置该 run 的协作式 `CancellationToken`；如果当前正在等待审批，会把对应 pending approval 解析为 `decision: "canceled"`，随后写入 `run.canceled`。
- provider wrapper 和命令类工具必须在可中断边界检查 token。DeepSeek streaming wrapper 会在 stream 事件之间检查 token；shell/search/git 等子进程工具会在轮询子进程状态时检查 token，并在取消或超时时清理子进程树。
- 当前内存队列默认审批超时为 300 秒；超时会把 approval 解析为 `decision: "expired"`，随后写入 `run.canceled`。测试和嵌入方可以通过 handler 配置缩短该时间。
- 当前取消是协作式，不是强制杀线程；stdio EOF / writer failure 已能取消 active run，包括等待审批和长时间 provider request 场景。命令类工具会在取消或超时时清理子进程树。

### `agent.steer`

向 active run 追加运行中的用户指导。该请求不创建新的 turn，不会取消当前 provider/tool 流程；Turn Loop 会在下一次 provider request 前把 steer 消息作为最新用户运行中指令注入，并写入 `turn.steered` 事件。

```ts
interface SteerParams {
  runId: string;
  message: string;
}

interface SteerResult {
  runId: string;
  steerId: string;
  accepted: true;
}
```

规则：

- `runId` 必须匹配当前 active run；否则返回 `E_RUN_NOT_FOUND`。
- `message` 必须是非空文本；空白消息返回 invalid params。
- `agent.steer` 只是追加指导，不表示批准、拒绝或取消 pending approval。
- 如果当前 run 在收到 steer 前已经完成，handler 会先 drain terminal event，再返回 `E_RUN_NOT_FOUND`。

### `agent.resume`

恢复或回放之前的 run。

```ts
interface ResumeParams {
  runId: string;
  replayFromSeq?: number;
}
```

Result：

```ts
interface ResumeResult {
  runId: string;
  nextSeq: number;
  replayStarted: boolean;
}
```

规则：

- 如果提供 `replayFromSeq`，server 从该 seq 重新发送事件。
- 如果本地 run log 不存在，返回 `E_RUN_NOT_FOUND`。
- 当前 Rust request loop 已能解析 `agent.resume` 并分发给 handler；`AgentTurnLoopRpcHandler` 已能从 Run Log 按 `replayFromSeq` 重放事件。

### `agent.loadRunEvents`

从当前 workspace 的 run log 读取一页历史事件。该方法用于前端向上滚动加载更早 timeline，不会把返回事件作为 `agent.event` / `agent.eventBatch` notification 重新发送，也不会触发历史审批副作用。

```ts
interface LoadRunEventsParams {
  runId: string;
  beforeSeq?: number;
  limit?: number;
}

interface LoadRunEventsResult {
  runId: string;
  events: AgentEventEnvelope[];
  firstSeq?: number;
  lastSeq?: number;
  hasMoreBefore: boolean;
}
```

规则：

- `beforeSeq` 是 exclusive 上界；省略时从 run log 末尾取最近一页。
- `limit` 由 server 限制在 1 到 500 之间，默认 200。
- 返回的 `events` 保持升序，使用与 live/replay 相同的 `AgentEventEnvelope` shape。
- 如果本地 run log 不存在，返回 `E_RUN_NOT_FOUND`。

### `agent.listRuns`

列出当前 workspace 已知的本地 run。

```ts
interface ListRunsParams {
  limit?: number;
}

interface RunSummary {
  runId: string;
  title: string;
  status: "running" | "completed" | "failed" | "canceled";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  lastSeq: number;
  eventCount: number;
  mode?: "plan" | "edit" | "review" | "ask";
  summary?: string;
  changedFiles?: string[];
  verificationStatus?: "passed" | "failed" | "skipped";
}

interface ListRunsResult {
  runs: RunSummary[];
}
```

规则：

- `agent.listRuns` 读取每个 run 目录内的 `summary.json`，不扫描完整 `events.jsonl`。
- 缺少 `summary.json` 的旧 run 目录不会出现在列表中；后续若需要兼容旧日志，可增加显式迁移命令。
- 返回顺序按 `updatedAt` 从新到旧排序；时间相同时按 `runId` 升序稳定排序。
- `limit` 省略时返回全部已知 run；传入时只返回前 N 条。
- 当前 Rust request loop 已能解析 `agent.listRuns` 并分发给 handler；`AgentTurnLoopRpcHandler` 已能从 Run Log summary metadata 返回列表。

### `agent.deleteRun`

删除当前 workspace 内的本地 run log。

```ts
interface DeleteRunParams {
  runId: string;
}

interface DeleteRunResult {
  runId: string;
  deleted: true;
}
```

规则：

- `agent.deleteRun` 仅删除通过 run id 校验后的 `.prole-coder/runs/<runId>` 目录；非法 id 不会解析为文件路径。
- 如果本地 run log 不存在，返回 `E_RUN_NOT_FOUND`。
- 如果该 run 正在当前 RPC handler 内 active，返回 `E_RUN_ALREADY_ACTIVE`，前端应先取消或等待 run 收口。
- 当前 Rust request loop 已能解析 `agent.deleteRun` 并分发给 handler；`AgentTurnLoopRpcHandler` 已能删除 inactive run 并保持 list/resume 语义一致。

### `agent.previewFim`

请求一次 fill-in-the-middle completion preview。该方法用于编辑器 inline completion，不创建 run，也不写入 run log。

```ts
interface FimPreviewParams {
  prefix: string;
  suffix?: string;
  path?: string;
  languageId?: string;
  model?: string;
  maxTokens?: number;
}

interface FimPreviewResult {
  text: string;
  model: string;
  finishReason?: string;
}
```

规则：

- `prefix` 必须非空。
- `model` 只能由 client 在 server capability 明确支持 FIM 时传入；前端不得靠模型名称推断能力。
- `maxTokens` 是 provider 请求上限，不改变 server 侧上下文预算。
- 当前 Rust request loop 已能解析 `agent.previewFim` 并分发给 handler；CLI fixture provider 返回可测试预览，DeepSeek provider 通过 beta FIM completion endpoint 获取结果。

## 事件封装

所有 server event 使用该 envelope：

```ts
interface AgentEventEnvelope<TPayload> {
  seq: number;
  time: string;
  type: string;
  runId?: string;
  turnId?: string;
  payload: TPayload;
}

interface RunLogTruncation {
  path: string;
  reason: "max_string_bytes" | "max_array_items";
  original: number;
  stored: number;
}

interface RunLogPayloadMetadata {
  runLogTruncation?: RunLogTruncation[];
}
```

Phase 2d 起，所有 Run Log payload 写入前都会经过统一脱敏/截断。任意事件 payload 都可能带有 `runLogTruncation`；前端应把它视为元数据，用来区分“字段不存在”“字段为空”和“字段因大小限制被截断”。当前默认边界是单字符串 16 KiB、单数组 256 项。

规则：

- `seq` 在 run log 内单调递增。
- 属于某个 run 的事件必须包含 `runId`。
- 属于某个 turn 的事件应包含 `turnId`。
- 事件必须能在不依赖前端本地状态的情况下追加到 run log。

## 事件

### `run.started`

```ts
interface RunStarted {
  runId: string;
  workspaceRoot: string;
  mode: "plan" | "edit" | "review" | "ask";
}
```

### `run.completed`

```ts
interface RunCompleted {
  summary: string;
  changedFiles: string[];
  verificationStatus: "passed" | "failed" | "skipped";
}
```

### `run.failed`

```ts
interface RunFailed {
  code: string;
  message: string;
  details?: unknown;
  diagnosticFile?: string;
}
```

当 tool-call `function.arguments` 本身不是合法 JSON 时，Agent Core 会把脱敏后的原始累计 arguments 写入当前 run 目录下的诊断文件，并在 `diagnosticFile` 返回该本地文件路径。该字段只用于本地排查，不要求前端把文件内容重新发送给模型。

当 provider 建立 streaming response 或等待下一段 stream event 超过配置的 idle timeout 且连续重试耗尽时，`run.failed.code` 为 `E_PROVIDER_TIMEOUT`，payload 还会包含 `timeoutMs`、`attempts`、`partialContentChars` 和 `partialReasoningChars`。该错误属于 provider 连接失败收口；JSON-RPC 方法级错误仍归入 `E_PROVIDER_ERROR` 对应的 provider 类错误码。

### `run.canceled`

```ts
interface RunCanceled {
  code?: string;
  message?: string;
  approvalId?: string;
  toolCallId?: string;
  reason?: string;
}
```

### `turn.started`

```ts
interface TurnStarted {
  turnId: string;
  userTask: string;
  supersedes?: TurnSupersedes;
}
```

`supersedes` 与 `agent.sendTurn.supersedes` 语义一致，只出现在编辑重发的新 turn 上；旧 turn 的 `turn.started` 仍保留原始 `userTask` 以满足本地审计和故障复盘。

### `turn.steered`

```ts
interface TurnSteered {
  steerId: string;
  message: string;
}
```

该事件表示用户在 run 执行期间发送了补充指导。它用于 run log 审计和前端 timeline 展示；实际 provider 注入发生在下一次 provider request 前，注入内容会明确要求模型把 steer 当作最新用户指令遵循，因此如果 run 已在当前 provider/tool 循环内自然完成，steer 可能不会再影响模型输出。

### `assistant.delta`

面向用户展示的 assistant 输出。

```ts
interface AssistantDelta {
  text: string;
  iteration?: number;
  stream?: boolean;
}
```

`stream: true` 表示该事件来自 provider streaming delta；省略或为 false 时，通常表示非 streaming provider 在 `Completed` 后补写的一次完整可见文本片段，或 resume 时按原 payload 回放的历史事件。Provider-private reasoning 不通过该事件发送。如果 provider 要求后续请求携带 reasoning state，由 Agent Core 内部处理；除非显式开启 debug logging，否则只记录安全摘要。

### `plan.updated`

```ts
interface PlanUpdated {
  steps: PlanStep[];
}
```

### `context.built`

```ts
interface ContextBuilt {
  inputTokens: number;
  maxInputTokens: number;
  stablePrefixHash: string;
  stablePrefixTokens: number;
  stablePrefixBudgetTokens: number;
  stablePrefixBudgetRatioPpm: number;
  dynamicPreludeTokens: number;
  turnSuffixTokens: number;
  estimator: {
    name: string;
    exact: boolean;
    description: string;
    calibration?: {
      sampleCount: number;
      inputUnit: string;
      slopePpm: number;
      interceptTokens: number;
      meanAbsolutePercentageErrorPpm: number;
    };
  };
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  includedSources: Array<{
    kind:
      | "system_policy"
      | "project_rules"
      | "user_task"
      | "workspace_manifest"
      | "git_status"
      | "git_diff"
      | "file"
      | "selection"
      | "explicit_content"
      | "tool_result"
      | "plan"
      | "acceptance_criteria"
      | "previous_run_summary"
      | "diagnostic"
      | "other";
    required: boolean;
    path?: string;
    commandId?: string;
    title?: string;
    tokens: number;
    reason: string;
  }>;
  omittedSources: Array<{
    kind:
      | "system_policy"
      | "project_rules"
      | "user_task"
      | "workspace_manifest"
      | "git_status"
      | "git_diff"
      | "file"
      | "selection"
      | "explicit_content"
      | "tool_result"
      | "plan"
      | "acceptance_criteria"
      | "previous_run_summary"
      | "diagnostic"
      | "other";
    required: boolean;
    path?: string;
    commandId?: string;
    title?: string;
    estimatedTokens: number;
    inclusionReason: string;
    omissionReason: "token_budget_exceeded" | "stable_prefix_budget_exceeded";
  }>;
  sections: Array<{
    placement: "stable_prefix" | "dynamic_prelude" | "turn_suffix";
    tokens: number;
    itemCount: number;
  }>;
  manifest?: {
    manifestHash: string;
    maxEntries: number;
    totalDiscoveredFiles: number;
    includedFiles: number;
    omitted: Array<{
      reason: string;
      count: number;
    }>;
  };
}
```

Phase 2c 扩展后，`context.built` 不携带完整 prompt 文本，只携带可审计的 token/source/section 报告。`stablePrefixHash` 用于比较同一 workspace 的稳定前缀是否发生变化；`estimator.calibration` 只记录聚合校准元数据，不能包含可还原 prompt 的样本内容。`manifest` 字段来自自动生成或调用方提供的 workspace manifest summary，用于让前端解释稳定前缀、截断原因和 manifest hash。attachments 会以 `file`、`selection`、`explicit_content`、`diagnostic` 等 source kind 进入 `includedSources` / `omittedSources`，但 payload 不回传 attachment 正文。

### `provider.requested`

```ts
interface ProviderRequested {
  iteration: number;
  messageCount: number;
  reasoningState:
    | { state: "no_replay_required" }
    | { state: "replay_required"; assistantMessages: number };
}
```

### `provider.retrying`

该事件表示 Turn Loop 已决定重新发起 provider request。当前用于 transient stream error 和 provider idle timeout 两类可重试连接问题。

```ts
interface ProviderRetrying {
  iteration: number;
  reason: "transient_stream_error" | "provider_idle_timeout";
  message: string;
  retriesRemaining: number;
  partialContentChars: number;
  partialReasoningChars: number;
  timeoutMs?: number;
}
```

### `provider.completed`

Phase 2c 新增。该事件表示一次 provider 调用结束，用于记录 usage、cache 和 streaming 摘要；它不替代 `provider.requested`。

```ts
interface ProviderCompleted {
  iteration: number;
  model: string;
  durationMs: number;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
    reasoningTokens?: number;
  };
  streaming?: {
    chunkCount: number;
    toolCallDeltaCount: number;
  };
}
```

### `tool.requested`

```ts
interface ToolRequested {
  toolCallId: string;
  name: string;
  risk: RiskLevel;
  riskReasons?: string[];
  argumentsPreview: unknown;
}
```

### `tool.approvalRequired`

```ts
interface ToolApprovalRequired {
  approvalId: string;
  toolCallId: string;
  toolName: ToolName;
  risk: RiskLevel;
  title: string;
  detail: string;
  cwd?: string;
  command?: string;
  outputSummary?: string;
  paths?: string[];
  hunks?: PatchApprovalHunk[];
  riskReasons?: string[];
  persistable: boolean;
}
```

### `tool.approvalResolved`

```ts
interface ToolApprovalResolved {
  approvalId: string;
  toolCallId: string;
  toolName: ToolName;
  decision: "approved" | "rejected" | "canceled" | "expired";
  reason?: string;
  hunks?:
    | { scope: "all" }
    | {
        scope: "selected";
        approved: string[];
      };
}
```

该事件记录用户、策略或 RPC 队列对审批请求的决定。`decision: "approved"` 后续应进入 `tool.started`；`hunks.scope: "selected"` 表示后续只会应用指定 hunk id。`decision: "rejected"` 后当前工具调用不得执行，run 可以失败、继续只读工作或让模型请求不同操作；`decision: "canceled"` 和 `decision: "expired"` 表示 active run 被用户取消或审批超时，后续必须写入 `run.canceled`，对应工具不得执行。CLI 当前会把 prompt 的批准/拒绝写入该事件；RPC handler 的 pending approval 队列会在 `agent.approve` / `agent.reject` / `agent.cancel` 或超时后写入同等事件。

### `tool.started`

```ts
interface ToolStarted {
  toolCallId: string;
  name: string;
}
```

### `tool.completed`

```ts
interface ToolCompleted extends RunLogPayloadMetadata {
  toolCallId: string;
  name: string;
  status: "ok" | "failed";
  summary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  result?: unknown;
}
```

### `patch.proposed`

```ts
interface PatchProposed {
  patchId: string;
  approvalId: string;
  files: string[];
  unifiedDiff: string;
  summary: string;
}
```

需要审批的 patch 通过其中的 `approvalId` 使用 `agent.approve` 批准。普通 workspace `apply_patch` 默认不产生审批；当未来高风险 patch 或显式审批路径发出 `tool.approvalRequired` 时，payload 可以在 `hunks` 中暴露可批准 hunk，client 可以发送 `agent.approve` 的 `hunks.approved` 只批准其中一部分。

### `patch.applied`

```ts
interface PatchApplied {
  patchId: string;
  files: string[];
}
```

### `verification.started`

```ts
interface VerificationStarted {
  verificationId: string;
  command: string;
  cwd: string;
}
```

### `verification.completed`

```ts
interface VerificationCompleted extends RunLogPayloadMetadata {
  verificationId: string;
  status: "passed" | "failed";
  exitCode: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
}
```

`stdout` / `stderr` 必须在持久化和事件发送前应用与 `tool.completed.result` 相同的脱敏规则；前端不能假设验证命令输出是原始 shell 输出。

## 审批状态机

```text
pending
  -> approved
      -> executing
          -> completed
          -> failed
  -> rejected
  -> canceled
  -> expired
```

规则：

- 审批请求只能使用一次。
- 被拒绝的请求不得换一个 id 重试，除非请求的操作发生实质变化。
- destructive 操作永远不可持久化。
- protocol `0.1.0` 中 network 操作不可持久化。

## 错误模型

JSON-RPC 标准错误保留标准语义。项目特定错误使用 `-32000` 到 `-32099` 范围。CLI `run --json` 也复用同一套错误码：它不是一个真正的 JSON-RPC request，但失败时会在 stdout 输出一行 `id: "cli.run"` 的 JSON-RPC error response，方便脚本和前端统一解析。

当前 request loop 已使用的 JSON-RPC 标准错误：

| Code | Name | 含义 |
| --- | --- | --- |
| -32700 | Parse error | 单行消息不是合法 JSON。 |
| -32600 | Invalid Request | 消息不是 JSON-RPC object、版本错误或初始化顺序错误。 |
| -32601 | Method not found | method 尚未被当前 request loop 支持。 |
| -32602 | Invalid params | params 无法反序列化为对应方法参数。 |
| -32603 | Internal error | server 或 CLI 在无法归类到项目错误码时出现内部错误。 |

| Code | Name | 含义 |
| --- | --- | --- |
| -32001 | `E_UNSUPPORTED_PROTOCOL` | client/server 协议版本不兼容。 |
| -32002 | `E_WORKSPACE_UNTRUSTED` | 当前 workspace 未信任，请求操作被禁用。 |
| -32003 | `E_RUN_NOT_FOUND` | 请求的 run 不存在于本地状态。 |
| -32004 | `E_RUN_ALREADY_ACTIVE` | 已存在冲突的 active run。 |
| -32010 | `E_INVALID_TOOL_ARGUMENTS` | tool-call 参数不是合法 JSON、payload 引用非法或发生其他终止型参数错误；已知工具 schema mismatch 也会作为失败 `tool.completed.result.errorCode` 返回 provider 重试。 |
| -32011 | `E_APPROVAL_NOT_FOUND` | approval id 未知、已过期或已使用。 |
| -32012 | `E_APPROVAL_DENIED` | 审批被拒绝，操作无法继续。 |
| -32020 | `E_CONTEXT_BUDGET_EXCEEDED` | 必需上下文无法放入配置的预算。 |
| -32030 | `E_PROVIDER_ERROR` | 模型 provider 返回错误或无效 stream。 |
| -32040 | `E_TOOL_EXECUTION_FAILED` | 工具在合法调用后执行失败。 |
| -32050 | `E_RUN_CANCELED` | run 已取消。 |
| -32060 | `E_INTERNAL_INVARIANT` | server 检测到内部不变量被破坏。 |

错误结构：

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "error": {
    "code": -32020,
    "message": "Required context exceeds token budget",
    "data": {
      "symbolicCode": "E_CONTEXT_BUDGET_EXCEEDED",
      "kind": "turn",
      "runId": "run_01",
      "requiredTokens": 1200000,
      "maxInputTokens": 1000000
    }
  }
}
```

Provider 配置错误可以在 `error.data` 中携带恢复动作。VS Code、TUI 等前端必须优先依据结构化字段决定 UX，不解析 `message` 文案：

```ts
interface RpcRecoverableAction {
  kind: "configureDeepSeekApiKey";
  label: string;
}

interface ProviderConfigurationErrorData {
  provider: "deepseek";
  configurationError: "missingApiKey";
  recoverableAction: RpcRecoverableAction;
}
```

例如 DeepSeek API key 缺失时，`agent.sendTurn` / `agent.previewFim` 会返回 `E_PROVIDER_ERROR`，并附带：

```json
{
  "provider": "deepseek",
  "configurationError": "missingApiKey",
  "recoverableAction": {
    "kind": "configureDeepSeekApiKey",
    "label": "Configure API Key"
  }
}
```

## 端到端示例

Client 发送 turn：

```json
{
  "jsonrpc": "2.0",
  "id": "req_2",
  "method": "agent.sendTurn",
  "params": {
    "message": "Run the tests and fix failures",
    "mode": "edit"
  }
}
```

Server 接受：

```json
{
  "jsonrpc": "2.0",
  "id": "req_2",
  "result": {
    "runId": "run_01",
    "turnId": "turn_01",
    "accepted": true
  }
}
```

Server 请求命令审批：

```json
{
  "jsonrpc": "2.0",
  "method": "agent.event",
  "params": {
    "seq": 4,
    "time": "2026-05-20T14:00:05Z",
    "type": "tool.approvalRequired",
    "runId": "run_01",
    "turnId": "turn_01",
    "payload": {
      "approvalId": "approval_01",
      "toolCallId": "tool_01",
      "toolName": "shell",
      "risk": "network",
      "title": "Run shell command",
      "detail": "Execute npm install; risk upgrade: dependency install/update",
      "cwd": "C:/workspace/prole-coder",
      "command": "npm install",
      "riskReasons": ["dependency install/update"],
      "persistable": false
    }
  }
}
```

Client 批准：

```json
{
  "jsonrpc": "2.0",
  "id": "req_3",
  "method": "agent.approve",
  "params": {
    "approvalId": "approval_01"
  }
}
```

随后 server 继续发送 `tool.started`、`tool.completed`、可选的 `patch.proposed`、verification events，最后发送 `run.completed`。

## 运行日志（Run Log）要求

Server 必须能够通过以下信息重建 run：

- initialize metadata
- user turns
- event stream
- approvals and rejections
- tool results
- patch proposals and applied patches
- verification results

Run log 持久化前必须脱敏密钥。

当前 `crates/agent-core/src/run_log.rs` 已实现内部 JSONL 存储层。内部事件使用 `timeUnixMs`，`crates/agent-rpc` 已实现基础 stdio 事件桥接，会在转换成 JSON-RPC notification 时生成协议 envelope 中的 `time` 字符串。
Run Log 写入入口会先脱敏，再执行字符串/数组大小限制；截断记录进入 payload 顶层 `runLogTruncation`。

## 实现说明

- `packages/protocol` 定义与本文档匹配的 TypeScript 类型、method 常量和错误码注册表。
- `crates/agent-rpc` 负责 Rust 协议结构和 JSON-RPC framing；当前已实现 Run Log 事件到 `agent.event` notification 的桥接，并让 `StdioEventBridge` 直接实现 `TurnEventSink`。
- `docs/protocol/tool-registry.v1.json` 当前用于校验 Rust 与 TypeScript 的基础工具注册表一致，包含工具风险、默认审批和当前实现状态。
- 当前 Rust 和 TypeScript 测试都会校验协议错误码表，避免实现常量与文档漂移。后续应继续增加事件 payload 和 RPC method 的兼容性测试，验证 Rust 和 TypeScript 的协议定义一致。

## 后续增强

- 为 `tool.completed`、`patch.proposed` 等事件补齐与 Rust 结果类型一致的详细 payload schema。
- 将现有工具注册表和错误码注册表 fixture 扩展到事件 payload 和 RPC method，确保 `docs/json-rpc-protocol.md`、`packages/protocol` 和 `crates/agent-rpc` 不分叉。
- 扩展 attachment payload schema，把 diagnostic severity、code、source 等字段从纯文本升级为结构化字段。
- 将 `provider.completed` 的 usage/cache/streaming 字段纳入更完整的 Rust/TypeScript 事件 payload fixture，避免文档、core 和前端类型漂移。
- 建立 `assistant.delta` 高频事件的批量发送、节流或合并策略，并用 benchmark 验证 stdio JSON-RPC 在 VS Code 扩展中的流畅度。
- 明确事件重放规则：run resume 时哪些事件原样回放，哪些事件需要标记为历史事件。
- 在协议层表达 workspace trust、审批持久化能力和禁用工具原因，避免 UI 自行推断。
