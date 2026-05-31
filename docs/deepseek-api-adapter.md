# DeepSeek API Adapter

状态：草案，Phase 1 基础实现和 Phase 4 FIM preview 边界已完成。

本文档定义 `ProleCoder` 访问 DeepSeek API 的 Rust adapter。它属于 Agent Core 的 provider 边界，不直接处理 UI、审批、工具执行或 run log。

## 目标

- 使用 DeepSeek API 调用 `chat/completions`。
- 使用 DeepSeek beta FIM completion endpoint 支持编辑器 completion preview。
- 默认支持 `deepseek-v4-pro`，同时保留 `deepseek-v4-flash`。
- 显式表示 `thinking`、`reasoning_effort`、`reasoning_content`、tool calls、usage 和 cache token 字段。
- 保持请求和响应类型的表达性，使未来适配不同 provider、私有部署或兼容协议时不丢失语义。
- 解析 HTTP streaming 响应，包括分块 SSE、`: keep-alive`、`data: [DONE]` 和 `include_usage` 产生的空 choices usage chunk。
- API Key 只来自环境变量或未来的安全配置来源，不进入 Debug 输出、run log 或错误上下文。

## 非目标

- 不在 adapter 内实现 Agent 回合循环。
- 不在 adapter 内执行工具调用。
- 不在 adapter 内决定审批策略。
- 不在自动测试中真实调用 DeepSeek API。
- 不把某个第三方兼容协议作为 adapter 的公开命名或主要抽象。
- 不兼容即将弃用的 `deepseek-chat`、`deepseek-reasoner` 旧模型名，除非用户显式配置。

## 官方接口约束

DeepSeek API 默认 base URL：

```text
https://api.deepseek.com
```

Chat Completions endpoint：

```text
POST /chat/completions
```

FIM Completion 默认 base URL：

```text
https://api.deepseek.com/beta
```

FIM Completion endpoint：

```text
POST /completions
```

FIM 请求使用 `prompt` 作为 cursor 前缀，`suffix` 作为 cursor 后缀，`stream` 固定为 `false`。VS Code inline completion 会通过 RPC `agent.previewFim` 请求该路径；前端只在 server capability 明确标记模型 `supportsFim` 时发送请求。当前 DeepSeek chat 与 beta FIM endpoint 使用同一个 `DEEPSEEK_API_KEY`，只在默认 base URL 上区分 `https://api.deepseek.com` 与 `https://api.deepseek.com/beta`。

当前主要模型：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

思考模式参数：

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

`thinking.type` 支持 `enabled` 和 `disabled`。`reasoning_effort` 在本项目中只发出 `high` 与 `max`，不主动使用会被服务端映射的兼容值。`reasoning_effort` 只在 `thinking.type = enabled` 时发送；当请求显式关闭 thinking 时，adapter 会移除 `reasoning_effort`，避免生成服务端拒绝的参数组合。

DeepSeek V4 thinking mode 不支持 `tool_choice`。adapter 在发送请求前执行本地校验：

- `thinking.type = disabled` 且仍带有 `reasoning_effort` 时失败。
- `tool_choice` 存在且 thinking 未显式关闭时失败。

Streaming 使用 data-only SSE。服务端可能发送：

- `: keep-alive`
- `data: {...chat.completion.chunk...}`
- `data: [DONE]`

当 `stream_options.include_usage = true` 时，结束前会额外返回一个 usage chunk，其 `choices` 为空。

## Rust 模块

实现位置：

```text
crates/agent-core/src/provider/deepseek_api.rs
```

核心类型：

- `DeepSeekApiConfig`：base URL、模型、超时和 API Key。
- `DeepSeekApiAdapter`：持有 `reqwest::Client`，负责发送 HTTP 请求。
- `ChatCompletionRequest`：DeepSeek chat completion 请求体。
- `ChatCompletionResponse`：非流式响应。
- `ChatCompletionChunk`：流式 chunk。
- `ChatCompletionStream`：HTTP streaming 响应转换后的事件流。
- `FimCompletionRequest`：DeepSeek FIM 请求体，包含 `model`、`prompt`、可选 `suffix`、可选 `max_tokens`，并默认 `stream = false`。
- `FimCompletionResponse` / `FimCompletionChoice`：FIM 非流式响应和 text choice。
- `SseEventParser`：增量解析 SSE byte chunks。
- `StreamEvent`：`Chunk` 或 `Done`。
- `parse_stream_event_block`：解析单个 SSE event block。
- `ChatToolCallDelta`：streaming delta 中的工具调用片段，包含 `index`、可选 id/type 和可选 function 片段。
- `ChatToolCallAccumulator`：把同一 `index` 的 tool call delta 拼装成完整 `ChatToolCall`，并显式拒绝缺失 id/type/function name 或冲突元数据。

Adapter 本身仍只暴露 DeepSeek 原始请求、响应和 stream 结构，不直接写 run log。CLI DeepSeek provider wrapper 已在 `TurnProvider::complete_stream` 边界上消费 `ChatCompletionStream`，把 content delta 转为 `TurnProviderEvent::AssistantDelta`，并把完整 content、`reasoning_content` 和通过 accumulator 拼装后的 tool calls 聚合进最终 `TurnProviderEvent::Completed`。

## 流式响应解析

DeepSeek streaming 返回 data-only SSE。网络层可能把一个 SSE event 切成多个 byte chunk，也可能把多个 event 放进同一个 byte chunk。因此 adapter 不直接按 HTTP chunk 边界解析 JSON，而是使用 `SseEventParser` 维护 byte buffer：

1. `create_chat_completion_stream` 发送 `stream = true` 请求。
2. 如果调用方没有显式设置 `stream_options`，adapter 默认设置 `include_usage = true`。
3. HTTP 状态码非 2xx 时，读取响应 body 并返回 `DeepSeekApiError::Api`。
4. 2xx 响应进入 byte stream，每次收到 bytes 后交给 `SseEventParser::push_bytes`。
5. parser 只在遇到完整 SSE event 分隔符后解析事件，支持 `\n\n`、`\r\n\r\n` 和混合换行分隔符。
6. `: keep-alive` 和空事件不产生 `StreamEvent`。
7. `data: [DONE]` 产生 `StreamEvent::Done`，上层收到后结束流。
8. HTTP stream 结束时如果仍有非空 byte buffer，返回 `IncompleteStreamEvent`，避免吞掉被截断的 JSON。

`parse_stream_event_block` 只处理完整 event block。它支持多行 `data:`，会按 SSE 语义用换行拼接数据行；这让测试可以覆盖协议解析，而不需要真实 API 调用。

tool call streaming 不能按普通完整 `ChatToolCall` 处理。真实响应可能把同一个工具调用拆成多片：

1. 第一片通常携带 `index`、id、type、function name 和 arguments 前缀。
2. 后续片使用相同 `index`，只继续携带 `function.arguments` 片段。
3. stream 结束后 accumulator 按 `index` 排序输出完整 `ChatToolCall`。

Accumulator 不补造缺失字段，不改写 arguments，也不尝试修复无效 JSON。缺 id、缺 type、缺 function name 或同一 `index` 出现冲突元数据时直接报错；arguments 是否满足工具 JSON Schema 仍由后续工具校验层负责。

## 环境变量

```text
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

运行时 adapter 仍然从 `DEEPSEEK_API_KEY` 读取密钥，chat completion 与 FIM preview 共用这个密钥。真实联网测试额外支持测试专用的 `PROLE_CODER_DEEPSEEK_API_KEY` 和 `.secrets/deepseek-api-key` 本地密钥文件；这个文件只放 API Key，不放 base URL 或模型名。测试侧读取优先级为 `PROLE_CODER_DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY`、`.secrets/deepseek-api-key`。`DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL` 有项目默认值，也可以在外部测试配置或当前 shell 环境变量中选择。

## 错误处理

adapter 使用显式错误枚举：

- 缺少 API Key。
- base URL 无效。
- 模型 ID 为空。
- 请求消息为空。
- FIM prefix 为空。
- FIM `max_tokens` 超出 1 到 4096 的边界。
- 非流式调用收到 streaming request。
- HTTP 发送失败。
- DeepSeek 返回非 2xx 状态。
- JSON 响应或 SSE data 解析失败。

非 2xx 响应保留 HTTP status 和响应 body，便于上层生成用户可读错误。API Key 不进入错误消息。

## reasoning_content 规则

adapter 只负责序列化和反序列化 `reasoning_content` 字段。是否需要在下一轮回传由 Agent Core 状态机决定：

- 没有工具调用的普通多轮对话，可以不把上一轮 `reasoning_content` 放入后续上下文。
- 发生工具调用后，后续所有相关 user 交互必须完整回传该 assistant 消息的 `reasoning_content`。

这一规则落在 Agent Core 的 `reasoning_content` 状态机，而不是 UI 或 provider adapter。详细设计见 `docs/reasoning-content.md`。

## 测试策略

当前测试不访问网络，覆盖：

- 配置 Debug 不泄露 API Key。
- base URL 带路径时 endpoint 拼接正确。
- thinking request 序列化。
- `thinking.type = disabled` 时不会发送 `reasoning_effort`。
- `tool_choice` 与 thinking mode 的不兼容组合会在本地校验失败。
- 非流式响应中 `reasoning_content`、tool calls、usage 反序列化。
- SSE keep-alive、chunk、usage chunk 和 `[DONE]` 解析。
- SSE byte parser 的跨 chunk、CRLF、无效 UTF-8 和不完整事件处理。
- streaming tool call delta 反序列化、arguments 分片拼接、并行 index 排序、冲突 id 拒绝和缺失元数据拒绝。
- function tool schema 序列化。

真实联网测试需要通过环境变量显式开启，并避免在 CI 中默认消耗 API 额度。

## 真实联网测试

真实联网测试位于：

```text
crates/agent-core/tests/deepseek_api_live.rs
```

这些测试默认不运行，必须同时满足：

- 测试被显式以 ignored test 方式运行。
- `PROLE_CODER_LIVE_TESTS=1`。
- `PROLE_CODER_DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY` 或 `.secrets/deepseek-api-key` 存在，且内容为真实 DeepSeek API Key。
- 当前网络可以访问 DeepSeek API。

当前 ignored live tests 包括：

- `live_chat_completion_smoke_test`：非流式基础可达性。
- `live_chat_completion_stream_smoke_test`：流式基础可达性。
- `live_reasoning_content_tool_replay_smoke_test`：thinking + tool call + `reasoning_content` 回传。
- `live_streaming_tool_call_accumulator_smoke_test`：强制真实 streaming tool call，验证 delta 可由 `ChatToolCallAccumulator` 拼装为完整工具调用，并确认 include_usage chunk 存在。
- `crates/cli/tests/deepseek_cli_live.rs` 中的 `live_deepseek_cli_streaming_smoke_test`：从 CLI 二进制启动真实 DeepSeek provider，验收 TurnProvider streaming wrapper、run log 和 JSON event 输出。
- `crates/cli/tests/deepseek_cli_live.rs` 中的 `live_deepseek_cli_real_repo_acceptance_test`：创建临时小型 Rust 仓库，从 CLI 二进制启动真实 DeepSeek provider，验收读取、`apply_patch` 写入、验证命令、JSON event 和 run log。当前该测试已在 Windows 本机通过，但仍不在 CI 默认运行；遇到 DeepSeek 524 时应暂停真实联网验收，待上游稳定后重跑。

Windows PowerShell 示例：

```powershell
$env:PROLE_CODER_LIVE_TESTS = "1"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
$env:DEEPSEEK_MODEL = "deepseek-v4-pro"
cargo test -p prole-coder-agent-core --test deepseek_api_live -- --ignored --nocapture
```

不要把真实 API Key 写入 Git 跟踪文件。推荐只放在当前 shell 环境变量、系统密钥管理器，或被 `.gitignore` 忽略的 `.secrets/deepseek-api-key` 中。base URL 和模型名不属于密钥，可以通过 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 或外部测试配置选择。CI 默认不会运行这些 ignored live tests。

`DeepSeekApiConfig` 默认 HTTP timeout 为 600 秒。若复杂 live test 在约 120 秒收到 HTTP 524，这通常是上游网关已经结束请求，而不是本地 HTTP client 过早超时；单纯把本地 timeout 调得更长一般不能让该请求恢复。

## 后续增强

- Provider capability model 已通过 Phase 4 P4-3 显式表达 thinking、tool_choice、FIM、stream usage、cache usage、最大上下文和最大输出长度；后续如模型真实能力变化，应先更新 capability data contract，再更新 UI 行为。
- 增加更细的错误分类，用于区分认证失败、限速、无效参数、服务端错误、网络中断和被截断的 stream；分类只用于明确提示和重试决策，不做静默兜底。
- 继续收集不同模型、不同工具 schema 和 thinking/tool-call 组合下的 streaming delta 形态，必要时补更细的兼容性测试。
- Phase 2c 已增加针对 cache usage 字段的离线测试、ignored live cache usage 实验入口，以及 `provider.completed` 上下文缓存统计记录。
- Phase 2c 已通过独立 `provider.completed` 事件记录模型名、duration、usage、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens` 和 streaming 摘要；该事件不与 `provider.requested` 混用。
- Phase 2b 已实现 `CalibratedEstimator` 的离线拟合与 metadata；Phase 2c 再通过 `provider.completed` 从真实 API usage 收集本地校准数据。校准样本只保存在本地，不进入仓库或公开 run log。
- 增加 provider 配置来源抽象：环境变量、本地配置文件、系统密钥管理器和测试专用 `.secrets/`，并统一保证 API Key 不进入 Debug、错误、run log 或文档示例。
- 保持真实联网测试为手动 opt-in，并继续控制 `max_tokens`，避免 CI 或普通开发命令产生不可预期的 API 消耗。

## 参考资料

- DeepSeek API 首次调用：https://api-docs.deepseek.com/zh-cn/
- DeepSeek Chat Completions：https://api-docs.deepseek.com/api/create-chat-completion
- DeepSeek FIM Completion：https://api-docs.deepseek.com/zh-cn/guides/fim_completion
- DeepSeek 思考模式：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- DeepSeek 模型与价格：https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek 限速说明：https://api-docs.deepseek.com/quick_start/rate_limit/
- DeepSeek 错误码：https://api-docs.deepseek.com/quick_start/error_codes
