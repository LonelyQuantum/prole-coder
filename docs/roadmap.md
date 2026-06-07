# 路线图

状态：草案，Phase 1 Agent Core MVP、合并主线前离线最终验收、Phase 2 的 1M Context Capsule 核心收敛、P2-5 展示型 demo 扩展、Phase 3 VS Code 插件核心与共享 RPC 事件队列和 Phase 4 VS Code 深度集成已完成；Phase 5 VS Code Codex-like UX 与开发工作流进行中。

本文档把 README 中的大阶段拆成更可执行的优先级。README 保留项目入口和高层计划；这里记录跨模块的落地顺序、取舍和验收重点。具体任务的阶段、状态和来源统一登记在 `docs/phase-tasks.md`，阶段条目标记完成前应同步检查并更新该索引。

## 定位

`ProleCoder` 不以第一阶段覆盖通用 AI 编程工具的全部功能为目标。项目的核心差异是：

- DeepSeek V4 1M 上下文优先。
- `reasoning_content`、上下文缓存和长输出能力一等支持。
- Rust Agent Core 供 CLI/TUI/VS Code 共用。
- 可复现 run log、显式审批和自由软件治理。
- 中文工作流友好。

因此短期不和成熟 VS Code 扩展正面拼功能覆盖率，而是先做出一个可审计、可复现、能稳定闭环的小型 Agent。

## P0：Phase 1 MVP 与合并主线前收敛

目标：完成一个最小但真实可用的 Agent 回合。

已完成：

- DeepSeek API adapter。
- 流式响应解析。
- `reasoning_content` 状态机。
- read/search/apply_patch/shell/git 基础工具执行层。
- 基础 Run Log 存储层。
- 基础 Context Builder 与 token 预算报告。
- 基础工具注册表 Rust/TypeScript 兼容性 fixture。
- Agent Turn Loop 基础编排和 fake provider 集成测试骨架。
- Agent RPC Server 最小 stdio 事件桥接。
- CLI `run` 最小闭环，支持 DeepSeek provider、fixture provider、run log 摘要、JSON event 重放和显式 verification command。
- 本地 fixture 端到端 smoke test，覆盖 CLI、Turn Loop、工具执行、Run Log 和 JSON-RPC event 输出。
- CLI 审查修复：DeepSeek provider 改为专用 current-thread runtime，fixture provider 改为响应队列，verification 输出在写入 run log 前脱敏。
- 进程级 CLI fixture smoke test：从编译出的 `prole` 二进制启动，验证 CLI、Turn Loop、Run Log、JSON-RPC event 输出、事件序号连续性和关键事件顺序的最小闭环。
- TurnProvider async / streaming 边界：`TurnProvider::complete_stream` 返回异步事件流，支持 `assistant.delta` 与最终 `Completed` 响应。
- CLI DeepSeek provider streaming wrapper：CLI provider 通过 `create_chat_completion_stream` 聚合 content、`reasoning_content` 和 tool calls，并把 content delta 写入 run log。
- 真实 provider streaming 联网验收：`deepseek_cli_live` 从编译出的 CLI 二进制启动真实 DeepSeek provider，验证 `stream: true` 的 `assistant.delta` 和最终 `run.completed`。
- streaming tool call 增量拼装验证：adapter 已区分 `ChatToolCallDelta` 与完整 `ChatToolCall`，`ChatToolCallAccumulator` 会按 `index` 拼接 arguments 并拒绝缺失或冲突元数据；`live_streaming_tool_call_accumulator_smoke_test` 已用真实 DeepSeek streaming 验收工具调用 delta 形态。
- Agent RPC Server 双向 request loop：`agent-rpc` 已支持 newline-delimited JSON-RPC request 读取、初始化顺序检查、`agent.initialize` / `agent.sendTurn` / `agent.resume` 分发、response/error 写回、EOF shutdown，以及 handler 返回事件的 `agent.event` 有序输出。
- RPC/CLI 实时事件输出：`AgentTurnLoop::run_turn_with_event_sink` 会在 Run Log 事件追加成功后立即调用 `TurnEventSink`；`StdioEventBridge` 已实现该接口，CLI `--json` 输出顺序与本地 `events.jsonl` 的 `seq` 一致，不再等 run 完成后批量回放。
- CLI/RPC/TUI/VS Code 审批基础：Turn Loop 会写入 `tool.approvalRequired` 和 `tool.approvalResolved`；CLI 二进制支持 stdin/stderr 交互式 y/n 审批；RPC request loop 已分发 `agent.approve` / `agent.reject`；TypeScript 协议类型已补齐；TUI prompt 状态机、VS Code legacy modal adapter 和默认 Sidebar 内联审批入口已有测试覆盖。
- 真实 RPC Turn Loop handler：`AgentTurnLoopRpcHandler` 已通过 provider factory 复用 Core Turn Loop，`agent.sendTurn` 会创建 run log、驱动 provider 和工具执行，并把结果事件交给 request loop；CLI `rpc` 子命令已提供 stdio 入口。
- RPC 真实审批等待队列：`AgentTurnLoopRpcHandler` 会在 `tool.approvalRequired` 处登记 pending approval，后台 Turn Loop worker 等待 `agent.approve` / `agent.reject`，批准后继续执行工具，拒绝后记录 `tool.approvalResolved` 和 `run.failed`。
- RPC 审批超时/取消：pending approval 已记录过期时间；`agent.cancel` 和 request loop EOF shutdown 会取消等待审批的 active run，超时会自动解析为 expired，这些路径都会记录 `tool.approvalResolved` 和 `run.canceled`。
- Run Log 写入串行化：Agent Core 已提供 `RunLogWriter` trait 和 `SerializedRunLog`；CLI 继续使用单 writer `RunLog`，RPC active run 使用共享锁串行化 append/load，避免同一 run 被多个前端请求并发读写时出现序列错乱。
- Run summary metadata / `agent.listRuns`：每个 run 目录维护 `summary.json`，记录标题、状态、时间、事件数、最终摘要、变更文件和验证状态；RPC `agent.listRuns` 通过 summary 快速列出 run，VS Code Sidebar Chat 已接入 Run List 并可用 `agent.resume` 回放历史事件。
- RPC provider/tool 取消信号：Agent Core 已提供协作式 `CancellationToken`；RPC active run 会把 token 注入 Turn Loop，`agent.cancel` 会通知 provider request、命令类工具和 pending approval，并以 `run.canceled` 收口。
- CLI JSON error response：`run --json` 失败路径会在 stdout 输出 JSON-RPC error response，保留非零退出码，并避免把人类错误摘要混入 stdout。
- 小型真实仓库 CLI 验收：`live_deepseek_cli_real_repo_acceptance_test` 已通过，真实 DeepSeek provider 在临时 Rust 仓库中完成“读取 -> 修改 -> 验证 -> 报告”。

合并主线前已完成：

- `pnpm run check` 基线验证：Windows 本机已通过默认 CI 等价检查。
- Context Builder token 预算测试：当前已覆盖 token 报告、可选上下文超预算省略、必需上下文超预算失败和 `context.built` payload 形状。
- Patch apply 失败恢复：`apply_patch` 已改为先 staging 再写盘，并有多文件失败不留半修改的回归测试；hunk mismatch / file mismatch / invalid patch 会作为 failed tool result 回传给模型重试。
- `reasoning_content` 状态机边界：已覆盖空消息、多个 tool-call assistant message 和 replay 计数。
- `CancellationToken` 并发语义：已覆盖 clone 共享状态、首次取消原因保持和并发取消。
- CLI event stream 顺序：进程级 smoke test 已验证 event `seq` 连续递增和关键事件子序列。
- 共享 `TestWorkspace`：`agent-core::test_helpers::TestWorkspace` 已统一 agent-core、agent-rpc、cli、demo/live 测试的临时工作区创建、保留、git 初始化和读写 helper。
- live API key 测试 helper：真实联网测试已统一通过 `PROLE_CODER_DEEPSEEK_API_KEY -> DEEPSEEK_API_KEY -> .secrets/deepseek-api-key` 读取本地密钥；运行时 provider 配置保持不变。
- RPC/CLI/protocol 合并前验收：`agent-rpc` 新增 pending approval 并发拒绝与 EOF shutdown 取消测试，`cli` 新增真实二进制 `rpc` stdio smoke，`packages/protocol` 与 `agent-rpc` 共同校验错误码表和协议文档一致。

合并主线前最终验收：

- 已运行 `pnpm run check`、`cargo test --workspace -- --list`、离线展示 demo、`git diff --check` 和敏感信息扫描。
- 本轮 RPC/CLI/protocol 离线变更未新增必须阻塞合并的 DeepSeek live suite；已有 live suite 仍按 `docs/testing.md` 保留为阶段合并前的手动验收选项。

下一步：

- 进入 Phase 3 VS Code 插件核心与共享 RPC 交互管线。
- RPC 全双工事件 writer 队列已完成：`agent.sendTurn` 会在创建 run 后返回 accepted，后台通过有界队列和单 writer 持续推送 live `agent.event`，断连时会取消 active run。
- TUI 保留为正式前端，但优先级调整到 VS Code 核心体验之后，复用同一套 RPC 事件管线和审批模型。

Phase 1 收官后优化池：

- RPC 事件输出模型收敛：独立 writer 队列和长 provider request 期间的断连取消已完成；后续重点转向 VS Code 侧真实事件消费、审批回传和 UI 状态管理。
- 工具执行安全打磨：Phase 3 已实现命令风险分类器和命令子进程树清理，并在审批信息中突出命令摘要和风险升级原因；后续补充更强 sandbox。
- Run Log 体积与隐私控制：为工具输出、verification 输出和 provider 摘要增加统一大小限制、截断原因和可导出的脱敏包边界。
- Provider summary 事件：把 usage、cache 命中、模型名、stream 统计等写成稳定 schema，避免只依赖 provider 私有响应。
- 本地环境诊断：增加 doctor 类检查，显式验证 `rg`、`git`、`cargo`、Node/pnpm、API key 来源和 workspace 信任状态；不做隐式搜索 backend 降级。
- 展示型 demo 维护：已有 `cargo demo` / `cargo demo-live` / `cargo demo-context` / `cargo demo-context-visual` / `cargo demo-truncation` / `cargo demo-schema` / `cargo demo-attachment`，后续新增展示场景继续统一登记到 `docs/demos.md`。

P0 不追求：

- 完整 VS Code Sidebar：已移入 Phase 3。
- 完整 TUI：已移入 Phase 6。
- VS Code/TUI 真实前端 UI 接入：Phase 3 优先 VS Code，Phase 6 再补齐 TUI。
- MCP 生态。
- 多 provider UI。
- 大仓库 1M token 基准。

这些功能应在核心闭环可复现之后再推进。

## 跨阶段前置项

这些工作已提前实现，用于压低后续前端集成风险，但不作为 Phase 1 / Agent Core MVP 的阻塞验收条件：

- VS Code RPC server 管理：插件激活后可按配置启动 `prole rpc`，发送 `agent.initialize`，转发 `agent.event`，并在进程退出或启动失败时提示用户；停止插件会关闭子进程。
- VS Code JSON-RPC request client：`RpcServerManager.sendRequest()` 统一管理 request id、pending response、error response 和进程退出时的 pending request 清理。

## P1：编辑器核心体验

目标：让 VS Code 插件成为 Agent Core 的薄前端，而不是第二套 Agent。

Phase 3 已交付 VS Code 插件核心体验；Phase 4 已完成 14 项 VS Code 深度集成任务；Phase 5 仍在进行中。P5-1 到 P5-17e 已完成原生 Chat 入口、简化审批、自动上下文压缩、UX 验收、Output Channel 错误诊断、插件内多 API key/model 配置、统一 redaction/错误恢复、只读 Git context、commit message 写入 SCM inputBox、PR markdown 生成、Sidebar 连续会话、Run 删除和折叠事件 UX、结构化 provider 配置错误码与恢复动作、真实试用回归修复包、Markdown/edit resend 后端语义、模型回合预算 continuation approval、Provider Key/Model 图标入口、run mode 自动推断、PowerShell 验证命令规则、Work log 分组、本对话命令审批复用、workspace-scoped 只读 shell 白名单和运行中 steer；P5-17z 作为持续 UX backlog，子项状态以 `docs/phase-tasks.md` 为准。Phase 5 全部完成后再进入 Phase 6，与生态扩展一起推进。Marketplace 发布不阻塞 Phase 4/5，当前已具备可安装 VSIX alpha / pre-release 产物和安装说明。P2-5 展示型 demo 已经给 VS Code Context Viz / Approval / Run Log UI 提供可观察样本。

优先事项：

- VSIX dry-run packaging smoke 和 `@vscode/test-electron` 最小 harness 已完成，已提前验证打包、activation、trusted workspace 和 Chat view 基础加载。
- Phase 5 的 P5-1 到 P5-17e Codex-like UX 与开发工作流已完成；P5-17z 真实试用 UX backlog 持续收敛仍有未完成项。
- G4 自动 commit / push / create PR 暂不纳入 Phase 5 完成口径，后续需要接入审批模型后再做。
- Provider capability model data contract 已完成，首版通过 `agent.initialize` 暴露给前端，不引入 heavy trait。
- 事件 payload schema、协议 fixture 与 RPC 高频事件批量发送已完成，batch 不改变 Run Log `seq` 和 replay 语义。
- `agent.cancel` 类型化 helper 与 Chat Cancel UI 已接入，并与 Terminal approval 做轻量 composer UX review。
- Problems 面板诊断已通过 diagnostic attachments 进入 Context Builder，插件不新增独立 diagnostics 状态同步 RPC。
- Terminal command approval 已支持命令、cwd、风险等级、风险原因、输出摘要字段和持久化语义；P5-2 后 VS Code 主审批动作保持 Approve / Reject，P5-14 默认改为 Sidebar 内联审批卡片。
- 审批持久化存储已支持 session/workspace，继续禁止 network/destructive 风险持久化。
- 配置界面依赖 Provider capability model；provider、model、预算、审批策略和 RPC 命令配置都不得保存 API Key。
- P5-12 已完成：Sidebar Chat 复用 `agent.sendTurn.runId` 继续同一 run 多轮对话，支持 `agent.deleteRun` 删除 inactive run；tool/provider/request 等过程事件默认折叠，完整 payload 写入 `Output > ProleCoder`。
- P5-13 已完成：provider 配置失败从前端字符串匹配升级为 RPC 结构化错误数据，缺少 DeepSeek API key 时返回 `E_PROVIDER_ERROR` 和 `data.recoverableAction`，供 VS Code/TUI 统一展示配置动作。
- P5-14：真实试用回归修复包已完成，用于收敛 Sidebar 对话视图、内联确认、Work log 折叠、Markdown 渲染、webview 渲染诊断、provider/shell 稳定性和 composer / Settings 入口回归；具体 P5-14a 到 P5-14h 子项见 `docs/phase-tasks.md`。
- P5-15 / P5-16 / P5-17a-e：真实试用 UX backlog 已分批收敛，包括 Markdown/edit resend、模型回合预算、Provider Key/Model 图标入口、run mode 自动推断、PowerShell 验证命令规则、Work log 分组、本对话命令审批复用、只读 shell 白名单和运行中 steer。
- P5-17z：真实试用 UX backlog 持续收敛仍未完成，用于登记新的 Runs、Key/Model/Settings、审批、Chat、Output 日志、上下文压缩和大工具参数稳定性问题。
- 真实 hunk 级 patch 边界首版限定 `apply_patch`；最多 5 个 `expectedFiles` 的普通 workspace 代码 patch 默认免审批，超过阈值的 bulk patch、workspace policy 文件 patch、高风险 patch 或显式审批路径仍使用 hunk 审批边界。
- FIM completion preview 依赖 Provider capability model，优先评估 VS Code 原生 inline completion 接入。
- VSIX alpha / pre-release 交付已完成，`pnpm run vsix:alpha` 会生成可安装 pre-release VSIX 和 SHA-256 校验和；end-to-end 集成测试已通过本地 JSON-RPC fixture server 覆盖 Chat sendTurn、Cancel、Problems diagnostics、自动审批、Run List / resume。

已完成的 Phase 3 基础：

- 原生 diff editor 展示 patch 已完成：VS Code 已具备虚拟 after 文档 diff 和 hunk boundary；最多 5 个 `expectedFiles` 的普通 workspace 代码 patch 默认免审批，diff / hunk 审批边界保留给 bulk patch、workspace policy 文件 patch、高风险 patch 或显式审批路径。
- Run List / resume 已完成：Sidebar Chat 用 `agent.listRuns` 展示最近 run summary，点击历史 run 后调用 `agent.resume` 并复用同一 `agent.event` 渲染路径。
- Context Capsule 可视化已完成：Sidebar Chat 消费 `context.built` metadata，展示三层 token 分布、来源纳入/省略、manifest、cache 和 estimator 摘要。
- Phase 3 命令风险分类器已完成：识别网络访问、依赖安装、远程 git、发布和破坏性命令，并在审批前升级风险。

当前验收重点：

- Phase 4 的 14 个条目已全部在 `docs/phase-tasks.md` 标记 `[x]`；Phase 5 仍有 P5-17z 未完成，README 不能把 Phase 5 写成整阶段完成。
- VS Code 插件可通过 VSIX 安装到 clean 环境。
- fixture provider 下 Chat sendTurn、Cancel、Problems diagnostics、审批和 Run List / resume 至少有一条 extension-host 或可重复手动验收路径。
- CLI 与 VS Code 对同一 fixture task 的关键 Run Log event type 顺序一致。
- 配置界面不保存 API Key，只管理非敏感配置。
- Phase 3 RPC 管线中，`agent.sendTurn` 创建 run 后返回 accepted，不等待 `assistant.delta`、审批或 terminal event。
- 同一 run 的 live `agent.event` notification 和 `agent.resume` replay 使用同一 Run Log `seq` 与 envelope。
- `context.built` 在插件侧只作为 Run Log metadata 渲染，插件不重新实现 context builder。
- 插件和 CLI 对同一任务产生一致 run log。
- 插件不直接实现 tool execution、context builder 或 turn loop。

## P2：DeepSeek 差异化

目标：把 DeepSeek V4 的长上下文和思考模式变成可见、可审计的工作流。

Phase 2 的 1M Context Capsule 按 5 个 README 大项推进：

1. **P2-1：Context Capsule 数据模型与 Workspace Manifest**
   - [x] `read_file` 增加 `sha256` / `sizeBytes`。
   - [x] 定义 `ContextCapsule`、`ContextSection`、`CachePlacement` 和稳定 renderer。
   - [x] 实现 workspace manifest v0：结构化 JSON、canonical `manifestHash`、默认 `maxEntries=500`、硬安全排除、默认工程排除、`.gitignore` + `.prole-coderignore`。
   - [x] Context Builder 接入 manifest summary，并扩展 `context.built` payload。

2. **P2-2：TokenEstimator 与稳定前缀**
   - [x] 建立 `TokenEstimator` trait，保留 `utf8_bytes` 默认估算器。
   - [x] 增加基于 provider usage 样本的 `CalibratedEstimator`，但仍标注 `exact=false`，且不保存 prompt 原文。
   - [x] 按 `CachePlacement::{StablePrefix, DynamicPrelude, TurnSuffix}` 构建缓存友好 prompt，并输出 `stablePrefixHash` 与稳定前缀预算。

3. **P2-3：Attachments、provider summary 与 cache 实验**
   - [x] 接入 `agent.sendTurn.attachments` 的 file、selection/explicit_content、diagnostic。
   - [x] 新增 `provider.completed` 事件，记录模型、duration、usage、cache hit/miss 和 stream 摘要。
   - [x] 建立 DeepSeek cache hit/miss ignored live experiment 的基础解析路径；更大重复前缀样本归入 P2-4 前增强。

4. **P2-4：大仓库验收与体积控制**
   - [x] 200K、500K、900K 样例仓库 token 预算和 Context Capsule ignored/manual 验收。
   - [x] 超预算解释、Run Log 输出截断和脱敏包边界。
   - [x] tool call JSON Schema 通用校验层，且在 typed deserialization 前执行。

5. **P2-5：合并主线前展示型 demo 扩展**
   - [x] `demo-context`：展示 manifest summary、Context Capsule sections、included/omitted sources 和 `context.built` payload。
   - [x] `demo-truncation`：展示 Run Log 脱敏、截断、`runLogTruncation`，并区分截断、空输出和缺失字段。
   - [x] `demo-schema`：展示 tool call arguments 在 typed deserialization 前被 JSON Schema 拒绝。
   - [x] `demo-context-visual`：用 ASCII 视图展示 StablePrefix、DynamicPrelude、TurnSuffix 的 token 分布，并输出原始 JSON。
   - [x] `demo-attachment`：展示 file、selection、explicit_content、diagnostic attachments 如何进入 Context Builder。
   - [x] `demo-live` provider summary 增强：展示模型、duration、usage、cache hit/miss 和 stream 摘要。

与 Phase 4 关联的 DeepSeek 差异化事项：

- `reasoning_content` replay 状态摘要。
- FIM completion preview 已纳入 Phase 4 `P4-12`，依赖 Provider capability model。
- 高频 JSON-RPC streaming 性能基准和必要的 delta 合并策略已纳入 Phase 4 `P4-5`。

验收重点：

- 能解释哪些内容进入上下文、哪些没有进入，以及原因。
- 能记录 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 并展示给前端。
- 同一输入两次构建的 `StablePrefix` 渲染完全一致，修改 `TurnSuffix` 不影响稳定前缀。
- Manifest 的 ignore、sha256、manifest hash、截断和 omitted reason 均可离线测试。

## P3：生态扩展

目标：在核心闭环、编辑器体验和 DeepSeek 差异化稳定后，再扩展通用能力。

候选事项：

- MCP client。
- 本地模型或私有推理服务适配器。
- 包管理器工具。
- issue/PR 工具。
- 审计包导出。
- 可复现发布和多渠道安装。

## 风险控制

- 避免只堆文档和抽象：每个阶段都应有可运行验收场景。
- 避免前端行为分叉：CLI/TUI/VS Code 必须共享 Agent Core 和 run log。
- 避免过早追求通用多模型：provider API 要保持表达性，但 DeepSeek 是首个落地目标。
- 避免把 1M 上下文当作兜底：长上下文必须配合 token 预算、来源标注和验证命令。
