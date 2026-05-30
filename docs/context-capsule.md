# 上下文胶囊（Context Capsule）

状态：草案，Phase 1 基础 Context Builder 已实现；Phase 2a/2b/2c/2d 已完成；Phase 3 的 VS Code/RPC 事件消费与 Context Capsule 可视化已完成首版；Phase 4 已补齐 VS Code Sidebar Chat 与原生 `@prole` Chat Participant 的自动上下文压缩 attachment。

Context Capsule 是一次模型回合的结构化输入包。它面向 DeepSeek 的长上下文和上下文缓存能力设计。

## 目标

- 稳定内容靠近 prompt 前缀。
- 易变内容靠近 prompt 后缀。
- 每个片段都能追溯来源。
- 发送前计算 token 预算。
- 必需上下文无法放入预算时显式停止。

## 结构

```text
[StablePrefix]
system policy
project rules
workspace manifest summary
stable file snapshots

[DynamicPrelude]
git status and diff summary
current diagnostics summary

[TurnSuffix]
user task
selected file contents
explicit attachments
tool results
active plan
acceptance criteria
previous run summary
```

Phase 2 不再只把 Context Capsule 视为一段拼好的 prompt 字符串。Agent Core 应先构建结构化结果，再由稳定 renderer 生成 provider 输入：

```rust
struct ContextCapsule {
    sections: Vec<ContextSection>,
    rendered: String,
    content: String,
    token_report: ContextTokenReport,
}

struct ContextSection {
    placement: CachePlacement,
    tokens: u64,
    items: Vec<ContextSectionItem>,
}

struct ContextSectionItem {
    placement: CachePlacement,
    source: ContextSourceRef,
    content: String,
    tokens: u64,
    reason: String,
}

enum CachePlacement {
    StablePrefix,
    DynamicPrelude,
    TurnSuffix,
}
```

`CachePlacement` 描述 prompt 布局位置，不等同于现有 `ContextItemKind::priority()`。`priority()` 继续用于同一区域内的确定性排序；`CachePlacement` 用于决定内容是否进入稳定前缀、动态前导区或当前 turn 后缀。Phase 2a-2 的实现位置是 `crates/agent-core/src/context.rs`：builder 先按 `CachePlacement::{StablePrefix, DynamicPrelude, TurnSuffix}` 分层，再按 `ContextItemKind::priority()` 做层内排序，最后由 `context_capsule.v1` renderer 生成 provider 输入。

`content` 是向后兼容字段，现阶段与 `rendered` 完全一致。Turn Loop 仍可继续读取 `content`；后续 provider cache 相关逻辑应以 `sections` 和 `rendered` 为主。

Phase 2b 已把 token 统计从硬编码 `text.len()` 抽成 `TokenEstimator`：

- `Utf8BytesEstimator`：默认估算器，使用 UTF-8 byte count 作为确定性代理估算，`exact=false`。
- `CalibratedEstimator`：基于 provider usage 样本拟合 `actual_tokens = slope * utf8_bytes + intercept`，仍标注 `exact=false`；实现只保存字节数、实际 token 数、系数和误差，不保存 prompt 原文。
- `TokenEstimatorReport`：进入 `context.built.estimator`，包含 `name`、`exact`、`description` 和可选 `calibration` 聚合元数据。

`ContextBuilderConfig` 默认 `stable_prefix_budget_ratio_ppm = 300000`，即 30% 输入预算分配给 `StablePrefix`。可选稳定前缀内容超过该预算时会被省略并记录 `stable_prefix_budget_exceeded`；必需稳定前缀仍优先保证正确性，整体上下文继续受 `max_input_tokens` 约束。`context.built` 同时输出 `stablePrefixHash`、`stablePrefixTokens`、`stablePrefixBudgetTokens` 和 `stablePrefixBudgetRatioPpm`，用于前端解释缓存友好前缀是否稳定。

默认 placement 建议：

| 来源 | 默认 placement |
| --- | --- |
| system policy、project rules、workspace manifest summary、稳定文件快照 | `StablePrefix` |
| git status summary、git diff summary、diagnostics summary | `DynamicPrelude` |
| user task、selected files、explicit attachments、tool results、active plan、previous run summary | `TurnSuffix` |

## Workspace Manifest v0

Manifest 是长上下文的骨架。Phase 2 使用结构化 JSON 作为内部表示，并用 canonical serialization 计算 `manifestHash`；prompt 中只放紧凑、稳定、可读的 manifest summary。

第一版字段：

```json
{
  "manifestVersion": 1,
  "manifestHash": "sha256:...",
  "workspaceRoot": "<redacted-or-local-only>",
  "maxEntries": 500,
  "totalDiscoveredFiles": 1234,
  "includedFiles": 500,
  "entries": [
    {
      "path": "src/lib.rs",
      "kind": "rust",
      "sizeBytes": 1200,
      "sha256": "...",
      "git": "working-tree",
      "risk": "source"
    }
  ],
  "omitted": [
    {
      "reason": "max_entries_exceeded",
      "count": 734
    }
  ]
}
```

`maxEntries` 默认 500。当前 v0 按稳定 path 排序后截断，省略项进入 `omitted` 和 `context.built.manifest`，不能静默丢弃；显式选中、已变化、根层级和源码/配置文件的优先保留策略留到后续 manifest ranking 扩展。

当前实现位置是 `crates/agent-core/src/workspace_manifest.rs`。v0 已支持：

- 稳定排序 entries，并记录 path、kind、sizeBytes、sha256、git state / object id、risk。
- canonical `manifestHash`，格式为 `sha256:<64 hex>`，hash 输入不包含本机绝对路径。
- `workspaceRoot` 固定为 `<workspace>`，避免 run log 或 prompt 泄露本机路径。
- 默认 `maxEntries=500`，超过预算时在 `omitted` 中记录 `max_entries_exceeded` 和数量。
- 使用 `ignore` crate 处理 `.gitignore` 与 `.prole-coderignore`，并显式执行硬安全排除与默认工程排除。

忽略规则分三层：

1. **硬安全排除**：`.git/`、`.secrets/`、密钥、证书、浏览器配置等，不能被用户规则重新纳入。
2. **默认工程排除**：`target/`、`node_modules/`、`dist/`、`build/` 等，可在后续配置中调整。
3. **用户上下文排除**：`.gitignore` 与 `.prole-coderignore`。`.prole-coderignore` 复用 gitignore 语法和 `!` negation，不引入额外自定义 include 语法。

## 来源元数据

每个上下文条目应携带：

- 来源路径或 command id
- 内容类型
- 字节长度
- token 估算
- 时间戳或 git object id
- 纳入原因

## 预算规则

必需上下文不能被静默丢弃。如果任务需要的材料无法放入预算，Agent Core 应报告缺失内容，并要求用户缩小任务范围或允许分阶段执行。

## 分阶段落地

Phase 1 已实现基础 Context Builder，不直接追求完整 1M Context Capsule：

- 输入来源限定为用户任务、项目规则、git 状态、显式选中文件、必要工具结果和当前计划。
- 每个上下文片段必须记录来源、纳入原因和 token 统计来源。
- 如果 token 统计只是估算，必须在结果中显式标注估算器；不能把估算当作精确值。
- 超预算时显式失败，并列出缺失内容，而不是静默丢弃必要上下文。

完整 workspace manifest、稳定前缀、缓存命中统计和大仓库基准属于 Phase 2。

Phase 2 按 4 个增量轮次落地：

| 阶段 | 内容 | 默认验收 |
| --- | --- | --- |
| Phase 2a | 已完成 `read_file` 增加 `sha256` / `sizeBytes`、`ContextCapsule` / `ContextSection` / `CachePlacement` 和稳定 renderer、workspace manifest v0、manifest summary 接入与 `context.built` payload 扩展。 | 已覆盖离线 fixture 仓库 manifest、hash、ignore、truncation、渲染稳定性和 Turn Loop `context.built` 事件测试。 |
| Phase 2b | 已完成 `TokenEstimator` trait、`Utf8BytesEstimator`、`CalibratedEstimator`、稳定前缀预算和 `stablePrefixHash`。 | 已覆盖校准估算器 fixture、修改 `TurnSuffix` 不改变 `StablePrefix`、可选稳定前缀超预算省略和 `context.built` metadata。 |
| Phase 2c | 已接入 `agent.sendTurn.attachments` 的 file/selection/explicit_content/diagnostic；新增 `provider.completed` usage/cache/stream 摘要事件。 | 已覆盖 attachment 越界、重复、超大小限制、RPC file attachment 和 provider summary 事件测试。 |
| Phase 2d | 已完成 200K/500K/900K 样例仓库验收入口、超预算解释、Run Log 体积/截断/脱敏边界和 tool call JSON Schema 通用校验层。 | `context_capsule_large_repository_budget_benchmark` 已作为 ignored/manual benchmark；schema validation 已在 typed deserialization 前执行；Run Log 使用 `runLogTruncation` 记录截断边界。 |

## 当前实现

实现位置：`crates/agent-core/src/context.rs`。

当前 Context Builder 提供：

- `ContextItem`：表示用户任务、项目规则、git 状态、文件、工具结果、计划等上下文片段。
- 分层稳定排序：`StablePrefix`、`DynamicPrelude`、`TurnSuffix` 决定 prompt 布局层；system policy、project rules、user task、manifest、git、file、tool result、plan 等来源继续用 `ContextItemKind::priority()` 做层内排序，避免把展示顺序与缓存前缀混用。
- 自动 manifest summary：Turn Loop 会在没有外部 `WorkspaceManifest` context item 时调用 `workspace_manifest`，把 summary 作为可选 `StablePrefix` item 注入 Context Builder。
- 工作区相对路径校验：拒绝绝对路径、Windows 盘符路径和 `..` 父目录路径。
- 来源冲突检查：`SystemPolicy`、`UserTask`、`WorkspaceManifest`、git 状态、计划等 singleton 类型只能出现一次；同一个文件路径或 command id 不能重复进入同一份上下文。
- token 预算控制：必需上下文超预算时显式失败；可选上下文超预算时跳过并写入 omitted source 报告。
- token 报告：输出 `inputTokens`、`maxInputTokens`、stable/dynamic/suffix section token、`stablePrefixHash`、稳定前缀预算、included sources、omitted sources、manifest hash / truncation 和估算器说明；校准估算器只记录聚合校准 metadata。
- 统一脱敏：进入上下文前复用 Run Log 的基础脱敏规则，避免把明显的 secret-like 文本写入 prompt。

默认 token 统计使用 `utf8_bytes` 估算器：它用 UTF-8 字节数作为确定性估算，不是 DeepSeek tokenizer 的精确 token 数。`CalibratedEstimator` 也必须报告 `exact=false`，前端和后续 turn loop 不能把它展示成精确模型 token。

当前 Context Builder 已接入基础 Agent Turn Loop。Turn Loop 会收集用户任务和调用方提供的上下文条目；如果调用方没有显式提供 `WorkspaceManifest` 条目，则自动生成 workspace manifest summary 放入 `StablePrefix`，生成 provider 请求输入，并把带有 section token 和 manifest 摘要的 `context.built` 事件写入 Run Log。基础 RPC 事件桥接和 `AgentTurnLoopRpcHandler` 已能把该事件发送为 JSON-RPC notification；VS Code Sidebar Chat 已能把 `context.built` metadata 渲染为 Context Capsule 面板，展示 StablePrefix / DynamicPrelude / TurnSuffix token 分布、input/stable budget、cache/estimator 摘要、included/omitted sources 和 manifest 摘要。后续仍需要扩展 git 状态、选中文件、工具结果和计划步骤的自动收集。

## 与工具系统的衔接

Context Capsule 不直接扫描工作区，而是消费工具系统和 run log 产生的结构化结果：

- `workspace_manifest` 提供稳定文件骨架、摘要、manifest hash、git state / object id、风险标记和 `max_entries_exceeded` 截断原因。
- `git_status` / `git_diff` 提供当前工作区变化摘要。
- `read_file` 和 `search` 提供已审计的文件片段与来源路径；`read_file` 已返回完整文件的 `sha256` 和 `sizeBytes`，供 manifest 和工具结果一致性校验使用。
- `agent.sendTurn.attachments` 现在直接进入 Context Builder：file attachment 由 Core 读取并继承 `read_file` 安全边界；selection、explicit_content 和 diagnostic 使用前端提供文本，但会做数量、大小、重复来源、路径和 range 校验。VS Code 插件已在发送 turn 时把 Problems 面板快照转换为 diagnostic attachments，并按协议 attachment 上限优先保留 error；Sidebar Chat 与原生 `@prole` Chat Participant 还会把历史对话/事件摘要压缩为受限长度的 `explicit_content` attachment，且 Sidebar timeline 单条消息在压缩前先限长，让连续对话自然承接上下文。
- `lsp_diagnostics` 提供编辑器或语言服务器诊断。
- 工具结果进入上下文前必须经过脱敏、大小限制和来源标注；Run Log 会对超长字符串和数组写入 `runLogTruncation`，让前端区分空输出、缺失字段和被截断输出。

## 后续增强

- 扩展 workspace manifest v0 的 omitted 统计，按 hard safety、default project exclude、`.gitignore` 和 `.prole-coderignore` 分组记录更细的 ignored reason。
- 为 `CalibratedEstimator` 增加本地配置加载/保存入口；校准样本文件必须放在本地私有配置或 `.secrets/` 类目录，不能进入仓库或公开 run log。
- 根据 Agent Turn Loop 的真实输入形态，评估是否允许多个 project rules、diagnostics 或分片后的 git diff/file chunk，并把允许重复的来源类型写入 schema。
- 在接入真实模型回合后验证当前 Markdown 元数据头格式的 prompt 效果；如果需要，抽象为可版本化的 prompt renderer。
- 扩展 DeepSeek cache hit/miss 手动实验样本，在大上下文重复前缀场景下记录更清晰的 ignored live 验收过程；该项不阻塞 Phase 2 收尾。
- 将 diagnostic attachment 从纯文本升级为结构化 severity、source、code、message 字段。
- 增加超预算诊断，明确列出哪些必需内容无法纳入、原因是什么、用户可以如何缩小任务。
- 给大文件和生成文件增加专门策略，避免把不可审计内容直接塞入 prompt。
