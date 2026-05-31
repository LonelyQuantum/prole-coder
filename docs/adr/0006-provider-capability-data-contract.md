# ADR 0006: Provider capability data contract

状态：Accepted

## 背景

Phase 4 需要让 VS Code 侧根据后端模型能力调整展示和后续交互，例如 thinking、tool calls、FIM、streaming/cache usage，以及上下文和输出上限。当前只有 DeepSeek V4 适配器，但协议应避免把这些能力散落在 UI 文案或配置推断中。

## 决策

在 `agent.initialize` 的 `capabilities.provider` 中返回 provider/model capability 数据契约：

- `provider` 与 `defaultModel` 描述当前默认 provider 和模型。
- `models[]` 描述每个模型的 `contextWindowTokens`、`maxOutputTokens`。
- `supportsThinking`、`supportsToolCalls`、`supportsToolChoice`、`supportsFim`、`supportsStreaming`、`reportsCacheUsage` 描述前端可见能力。

该契约先作为静态协议数据返回，不引入新的 provider trait。后续新增 provider 或模型时，再把静态默认值下沉到 provider registry。

## 影响

- VS Code 可以在初始化后读取稳定字段，而不需要解析模型名或依赖文档常量。
- Rust/TypeScript 协议类型同步维护该结构。
- `supportsToolChoice` 表示显式 `tool_choice` 参数能力，不等同于 tool calls；DeepSeek V4 当前返回 `false`，但 `supportsToolCalls` 为 `true`。
