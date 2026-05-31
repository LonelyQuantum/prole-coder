# 详细任务索引

状态：Phase 1、Phase 2、Phase 3、Phase 4、Phase 5 已完成。Phase 4 保留 14 项 VS Code 深度集成能力，Phase 5 记录 VS Code Codex-like UX 与开发工作流；下一阶段进入 Phase 6：TUI 与生态扩展。

本文档是详细设计文档里的任务账本。README 保留高层开发计划；这里把各模块文档中出现的“已实现、尚未实现、后续增强、下一步”收敛为可勾选任务，避免后续工作只散落在说明文字里。

维护规则：

- 新增任何预期实现项时，必须在本文件登记阶段和状态。
- README 开发计划中的阶段条目标记完成前，应检查本文件中对应细任务是否已经完成。
- 如果一个 README 条目完成了它蕴含的细任务，应同步把本文件对应行标记为 `[x]`，并在说明中写清验收方式。
- 详细模块文档仍保留设计说明；本文件只记录阶段、状态和追踪入口。

## 审计结论

本轮审计没有发现“详细文档声称属于 Phase 1 且已完成，但代码或测试明显尚未完成”的阻塞项。发现并修正了两处容易误导的描述：

- `docs/cli.md` 原先把 RPC 取消和审批过期也写成后续任务；实际 Phase 1 已实现显式取消、审批超时和 EOF shutdown 取消，Phase 3 已补齐全双工后台事件 writer。
- `docs/architecture.md` 原先把 VS Code 插件描述成完全没有接入真实 RPC server；实际 RPC server 启动监管和 request client 已提前完成，Phase 3 已补齐完整 Chat UI、事件渲染、审批回传和 diff editor 集成。

`RPC 全双工 reader/writer 与独立事件 writer 队列` 不属于 Phase 1 已完成范围；它已在 Phase 3 共享 RPC 交互基础设施中完成。

## Phase 0：项目章程

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | 项目名称、AGPL-3.0-or-later、Rust/TypeScript workspace、pnpm workspace、Windows 环境说明、CI 骨架和治理文件 | `README.md`、`docs/adr/`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md` | Phase 0 已完成并进入 README 高层计划。 |
| [x] | 建立 `docs/` 与 ADR，明确 README 只做入口和高层计划 | `docs/README.md`、`docs/adr/0005-keep-readme-as-entrypoint-and-move-design-to-docs.md` | 详细设计文档已按模块拆分。 |
| [x] | JSON-RPC 基础协议、工具 schema、风险等级和审批模型设计 | `docs/json-rpc-protocol.md`、`docs/tool-system.md`、`docs/approval-model.md` | Phase 0 设计完成；Phase 1 已实现基础执行闭环。 |

## Phase 1：Agent Core MVP

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | DeepSeek API adapter、data-only SSE parser、streaming 基础和真实联网 smoke | `docs/deepseek-api-adapter.md`、`docs/agent-core.md` | 已有离线解析测试和 ignored live tests。 |
| [x] | streaming tool-call delta accumulator | `docs/deepseek-api-adapter.md`、`docs/roadmap.md` | 已覆盖 delta 拼装、冲突和缺失元数据测试，并有 live forced tool-call 验收。 |
| [x] | `reasoning_content` replay 状态机 | `docs/reasoning-content.md` | 已覆盖 replay required、缺失 reasoning、thinking disabled 等边界。 |
| [x] | 基础 Context Builder 与 token 预算报告 | `docs/context-capsule.md`、`docs/agent-core.md` | Phase 1 仅实现基础 builder；完整 1M Capsule 归入 Phase 2。 |
| [x] | read/search/apply_patch/shell/git 工具执行层 | `docs/tool-system.md` | 已覆盖路径约束、敏感路径拒绝、命令超时、结构化结果和工具取消。 |
| [x] | Run Log `events.jsonl`、`summary.json`、脱敏和写入串行化 | `docs/run-log.md` | 已接入 CLI 和 RPC；全双工 notification writer 不属于 Phase 1。 |
| [x] | Agent Turn Loop 基础编排、工具审批、验证命令和 run log 写入 | `docs/turn-loop.md`、`docs/agent-core.md` | 已有 fixture 端到端和 CLI smoke。 |
| [x] | `TurnProvider` async / streaming 边界和 `TurnEventSink` 实时事件出口 | `docs/turn-loop.md` | CLI `--json` 和 `StdioEventBridge` 已接入。 |
| [x] | CLI `run` / `rpc` 最小闭环和 JSON-RPC 错误输出 | `docs/cli.md` | 已有库级、进程级和 fixture smoke 测试。 |
| [x] | Agent RPC Server request loop、真实 Turn Loop handler、pending approval、取消、超时、EOF shutdown 和 `agent.listRuns` | `docs/rpc-server.md`、`docs/json-rpc-protocol.md` | 已覆盖审批批准/拒绝/取消/超时、并发拒绝、EOF shutdown、resume/listRuns。 |
| [x] | CLI/TUI/VS Code 审批前端基础原语 | `docs/approval-model.md`、`docs/tui.md`、`docs/vscode-extension.md` | CLI prompt、TUI prompt 状态机、VS Code modal adapter 已实现；完整 UI 接入归入后续阶段。 |
| [x] | Rust/TypeScript 工具注册表和错误码协议交叉校验 | `docs/tool-system.md`、`docs/json-rpc-protocol.md`、`packages/protocol` | 工具 registry fixture 与错误码表已进入默认测试。 |
| [x] | 合并前测试基础设施、live 配置收敛和离线最终验收 | `docs/testing.md`、`docs/demos.md` | `pnpm run check`、测试清单、离线 demo、diff/sensitive scan 已完成。 |
| [x] | VS Code RPC server 管理和 JSON-RPC request client 前置实现 | `docs/vscode-extension.md`、`docs/roadmap.md` | 属于 Phase 3 前置项，已提前完成；不作为 Phase 1 阻塞验收条件。 |

## Phase 2：1M Context Capsule

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | Phase 2a-1：`read_file` 增加 `sha256` / `sizeBytes` | `docs/tool-system.md`、`docs/context-capsule.md` | 已完成：`read_file` 返回完整文件的 `sha256` 和 `sizeBytes`，Rust/TypeScript result schema 与单元测试已同步。 |
| [x] | Phase 2a-2：定义 `ContextCapsule` / `ContextSection` / `CachePlacement` 和稳定 renderer | `README.md`、`docs/context-capsule.md`、`docs/agent-core.md` | 已完成：三层布局与 kind priority 解耦，`context_capsule.v1` renderer 可稳定生成 provider 输入，`content` 兼容别名与 `rendered` 保持一致。 |
| [x] | Phase 2a-3：workspace manifest v0 自动构建 | `README.md`、`docs/context-capsule.md`、`docs/tool-system.md` | 已完成：结构化 JSON、canonical `manifestHash`、默认 `maxEntries=500`、硬安全排除、默认工程排除、`.gitignore` + `.prole-coderignore`，并提供可执行 `workspace_manifest` 工具。 |
| [x] | Phase 2a-4：Context Builder 接入 manifest summary 和扩展 `context.built` payload | `docs/context-capsule.md`、`docs/json-rpc-protocol.md` | 已完成：Turn Loop 自动生成 manifest summary 进入 `StablePrefix`，`context.built` 输出 stable/dynamic/suffix token、sections、manifest hash 和 `max_entries_exceeded` 截断原因。 |
| [x] | Phase 2b-1：TokenEstimator trait 与 `CalibratedEstimator` | `docs/roadmap.md`、`docs/context-capsule.md`、`docs/deepseek-api-adapter.md` | 已完成：新增 `token_estimator` 模块，默认保持 `utf8_bytes`；`CalibratedEstimator` 只保存字节数/实际 token 数和聚合误差，报告 `exact=false`，并有离线 fixture 测试。 |
| [x] | Phase 2b-2：稳定前缀和缓存友好 prompt 布局 | `README.md`、`docs/context-capsule.md`、`docs/deepseek-api-adapter.md` | 已完成：`ContextBuilderConfig` 增加 30% 默认稳定前缀预算，`context.built` 输出 `stablePrefixHash` 和预算字段；修改 `TurnSuffix` 不改变 `StablePrefix`、可选稳定前缀超预算省略均有测试。 |
| [x] | Phase 2c-1：Context Builder 接入 attachments 和 diagnostics | `docs/json-rpc-protocol.md`、`docs/context-capsule.md`、`docs/vscode-extension.md` | 已完成：`agent.sendTurn.attachments` 从拒绝改为消费，支持 file、selection、explicit_content、diagnostic；Core/RPC 已覆盖路径、重复和大小限制测试。 |
| [x] | Phase 2c-2：`provider.completed` 事件和 DeepSeek cache hit/miss 实验 | `README.md`、`docs/roadmap.md`、`docs/deepseek-api-adapter.md`、`docs/testing.md` | 已完成基础闭环：Turn Loop 独立记录模型、duration、usage、cache hit/miss 和 stream 摘要，DeepSeek streaming wrapper 会从 usage chunk 填充字段；更大 cache hit/miss 手动实验留作 Phase 2d 前增强样本。 |
| [x] | Phase 2d-1：200K、500K、900K 样例仓库 token 预算与 Context Capsule 验收 | `README.md`、`docs/testing.md`、`docs/context-capsule.md` | 已完成：新增 `context_capsule_large_repository_budget_benchmark` ignored/manual 测试，本地跑通 200K、500K、900K 三档样例 Context Capsule，默认 CI 只编译不自动执行。 |
| [x] | Phase 2d-2：超预算解释、Run Log 体积/截断/脱敏边界和 tool call JSON Schema 校验层 | `docs/run-log.md`、`docs/security-model.md`、`docs/agent-core.md`、`docs/tool-system.md` | 已完成：required context 超预算失败和 optional omitted reason 继续由 Context Builder 测试覆盖；Run Log 写入入口统一脱敏和字符串/数组截断并记录 `runLogTruncation`；tool call arguments 在 typed deserialization 前执行注册表 JSON Schema 校验。 |
| [x] | Phase 2e-1：展示型 demo 基础收敛 | `README.md`、`docs/demos.md`、`docs/testing.md` | 已完成：新增 demo 短命令均登记在 `.cargo/config.toml`，测试默认 ignored；`docs/demos.md` 作为统一清单记录用途、运行命令和预期输出。 |
| [x] | Phase 2e-2：`cargo demo-context` | `README.md`、`docs/demos.md`、`docs/context-capsule.md` | 已完成：展示 manifest summary、Context Capsule sections、included/omitted sources 和 `context.built` payload；已运行 `cargo demo-context`。 |
| [x] | Phase 2e-3：`cargo demo-truncation` | `README.md`、`docs/demos.md`、`docs/run-log.md` | 已完成：展示 Run Log 脱敏、截断、`runLogTruncation`，并区分截断、空输出和缺失字段；已运行 `cargo demo-truncation`。 |
| [x] | Phase 2e-4：`cargo demo-schema` | `README.md`、`docs/demos.md`、`docs/tool-system.md` | 已完成：展示 tool call arguments 在 typed deserialization 前被 JSON Schema 拒绝，并输出稳定 `E_INVALID_TOOL_ARGUMENTS`；已运行 `cargo demo-schema`。 |
| [x] | Phase 2e-5：`cargo demo-context-visual` | `README.md`、`docs/demos.md`、`docs/context-capsule.md`、`docs/vscode-extension.md` | 已完成：用 ASCII 视图展示 StablePrefix、DynamicPrelude、TurnSuffix 的 token 分布，并输出原始 JSON；已运行 `cargo demo-context-visual`。 |
| [x] | Phase 2e-6：`cargo demo-attachment` | `README.md`、`docs/demos.md`、`docs/json-rpc-protocol.md`、`docs/context-capsule.md` | 已完成：展示 file、selection、explicit_content、diagnostic attachments 如何进入 Context Builder 和 provider prompt；已运行 `cargo demo-attachment`。 |
| [x] | Phase 2e-7：`cargo demo-live` provider summary 增强 | `README.md`、`docs/demos.md`、`docs/deepseek-api-adapter.md`、`docs/roadmap.md` | 已完成：现有 live demo 的人类可读事件摘要会展示 `provider.completed` 的模型、duration、usage、cache hit/miss 和 stream 字段；离线 fixture 已运行，联网入口仍按 `PROLE_CODER_LIVE_TESTS=1 cargo demo-live` 手动执行。 |

## Phase 3：VS Code 插件核心与共享 RPC 交互管线

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | RPC 全双工 reader/writer 与独立事件 writer 队列 | `docs/rpc-server.md`、`docs/turn-loop.md`、`docs/run-log.md`、`docs/roadmap.md` | 已完成：`agent.sendTurn` 创建 run 后立即返回 accepted，后台 live `agent.event` 由有界队列和单 writer 持续推送；交互式 RPC 测试覆盖 response-before-event、provider 未完成前早返回、审批批准/拒绝/取消和 resume/listRuns。验收：`cargo test`、`cargo clippy --all-targets -- -D warnings`。 |
| [x] | 长 provider request 期间的 client 断连取消 | `docs/rpc-server.md`、`docs/json-rpc-protocol.md`、`docs/approval-model.md` | 已完成：stdio EOF / shutdown 会取消 active run，writer 失败会触发断连取消句柄并取消 active run 与 pending approvals。 |
| [x] | TypeScript extension scaffold | `README.md`、`docs/vscode-extension.md` | 已完成基础命令和测试骨架。 |
| [x] | RPC server 启动监管 | `README.md`、`docs/vscode-extension.md` | 已能启动 `prole rpc`、发送 initialize、转发事件并处理退出。 |
| [x] | JSON-RPC request client | `README.md`、`docs/vscode-extension.md` | 已管理 request id、pending response、error response 和进程退出清理。 |
| [x] | VS Code/protocol TypeScript 类型共享收敛 | `packages/protocol`、`docs/json-rpc-protocol.md`、`docs/vscode-extension.md` | 已完成：extension 通过 workspace devDependency 消费 `@prole-coder/protocol`，`rpcServer.ts` re-export protocol `AgentEventEnvelope` 类型 alias，删除本地重复 envelope 定义；extension build/typecheck/test/lint 会先构建 protocol 声明。 |
| [x] | VS Code RPC/commands 边界测试补齐 | `docs/vscode-extension.md`、`.agents/communication/daily/2026-05-28/code_review.md` | 已完成：`rpcServer.test.ts` 覆盖 spawn throw、stdio 缺失、invalid JSON、process error、stop pending startup、onEvent dispose、stderrPreview、sendRequest 写入失败和非 agent.event 通知；`commands.test.ts` 覆盖 openChat 启动失败提示、非 Error fallback、`persistable: false` approve 和 paths 拼接。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | Sidebar Chat 和 `agent.event` 渲染 | `README.md`、`docs/vscode-extension.md` | 已完成：VS Code 贡献 ProleCoder Activity Bar view 和 Webview Sidebar Chat；`ProleChatViewProvider` 订阅 `RpcServerManager.onEvent()`，通过 `ChatEventTimeline` 渲染 assistant delta、tool lifecycle、审批、context/provider 和 terminal event，并合并同一 run/turn 的 assistant delta。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | 文本输入发送 turn 并接收真实 Agent 响应 | `README.md`、`docs/vscode-extension.md`、`docs/json-rpc-protocol.md` | 已完成：Sidebar Chat 提供 prompt 输入和 mode 选择，Webview submit 经过 `chatInput` 校验后调用 typed `RpcServerManager.sendTurn()`，accepted 后通过同一 run 的 `agent.event` terminal event 收口输入状态。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | VS Code 审批 UI 接入真实 RPC pending queue | `docs/approval-model.md`、`docs/vscode-extension.md` | 已完成：新增 `ApprovalEventController` 订阅 `tool.approvalRequired`，校验 protocol payload 后调用 VS Code modal approval adapter，并通过 typed `RpcServerManager.approve()` / `reject()` 发送 `agent.approve` / `agent.reject`；重复 approvalId 不会重复弹窗。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | 命令风险分类器和动态风险升级 | `README.md`、`docs/approval-model.md`、`docs/tool-system.md`、`docs/turn-loop.md` | 已完成：Agent Core 对 shell 命令做词法分段和显式命令族分类，递归检查 shell 包装器、`$(...)` 和传统反引号子命令，识别依赖安装、网络访问、远程 git、删除和发布命令，升级 `tool.requested` / `tool.approvalRequired` 风险并输出 `riskReasons`；VS Code/CLI/TUI 展示升级原因。验收：`cargo fmt --check`、`cargo test -p prole-coder-agent-core command_risk`、`cargo test -p prole-coder-agent-core turn_loop_upgrades_shell_approval_risk`、`cargo test`、`cargo clippy --all-targets -- -D warnings`、`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`、`git diff --check`。 |
| [x] | 更强进程树清理策略 | `docs/tool-system.md`、`docs/security-model.md`、`docs/roadmap.md` | 已完成：命令类工具启动时建立可收束的进程树边界，Unix 使用独立 process group，Windows 使用新 process group、ParentProcessId descendant 枚举和 `taskkill /T /F` 兜底；取消和超时会清理 shell/search/git 等工具的子进程树。验收：`cargo test -p prole-coder-agent-core shell_cancels_descendant_processes`、`cargo test -p prole-coder-agent-core shell_timeout_cleans_descendant_processes`、`cargo test -p prole-coder-agent-core shell_cancels_running_command`。 |
| [x] | Native diff editor 与 hunk 级审批边界 | `README.md`、`docs/vscode-extension.md` | 已完成：VS Code 侧新增 patch preview controller，缓存 `tool.requested.argumentsPreview.unifiedDiff`，在 `apply_patch` 审批 modal 前打开 VS Code 原生 diff editor；纯 TS parser 会生成稳定 hunk approval boundary，当前仍以 whole-patch approve/reject 回传，为后续 hunk 级决策预留结构。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | Run List / resume | `README.md`、`docs/vscode-extension.md`、`docs/rpc-server.md` | 已完成：VS Code Sidebar Chat 通过 typed `RpcServerManager.listRuns()` 拉取最近 run summary，Run List 保留 loading/failed/selected 状态；点击历史 run 会调用 `agent.resume` 并清空当前事件视图，随后消费 replay 的 `agent.event`。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | Context Capsule 可视化 | `README.md`、`docs/context-capsule.md`、`docs/vscode-extension.md` | 已完成：VS Code Sidebar Chat 新增 Context Capsule 面板，消费 `context.built` metadata，展示 StablePrefix / DynamicPrelude / TurnSuffix token 分布、input/stable budget、cache/estimator 摘要、included/omitted source 预览和 manifest 摘要。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |

## Phase 4：VS Code 深度集成

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | P4-1：VSIX dry-run packaging smoke | `README.md`、`docs/vscode-extension.md`、`docs/release.md` | 已完成：新增 `pnpm run vsix:smoke` / `vscode/extension/scripts/vsixDryRunSmoke.mjs`，构建 protocol 与 extension 后在 `target/` 下临时生成 VSIX，检查 `.vscodeignore`、`workspace:*` 运行时边界、media asset、compiled `out/`、activationEvents 和包内排除规则，并清理临时产物；不代表 P4-13 完成。验收：`pnpm -r --if-present vsix:smoke`。 |
| [x] | P4-2：`@vscode/test-electron` 最小 harness | `README.md`、`docs/vscode-extension.md` | 已完成：新增 `pnpm run vscode:test-electron` / `vscode/extension/scripts/runVscodeIntegrationTests.mjs`，测试 extension activation、trusted workspace、Chat view focus 和命令注册；测试工作区禁用 RPC autoStart，并已扩展为 P4-14 E2E 入口。 |
| [x] | P4-3：Provider capability model data contract | `README.md`、`docs/roadmap.md`、`docs/deepseek-api-adapter.md`、`docs/json-rpc-protocol.md` | 已完成：新增 ADR 0006；`agent.initialize.capabilities.provider` 暴露 DeepSeek V4 model capability data contract，包含 thinking、tool calls/tool choice、FIM、stream/cache usage、上下文和输出限制，首版不引入 heavy trait。 |
| [x] | P4-4：事件 payload schema 与协议 fixture 对齐 | `docs/json-rpc-protocol.md`、`docs/turn-loop.md`、`packages/protocol` | 已完成：新增 `docs/protocol/event-payloads.v1.json`，将 `provider.requested`、`tool.completed`、`run.completed` 纳入 Rust/TypeScript 兼容性测试；VS Code 初始化协议版本不匹配会给出明确提示。 |
| [x] | P4-5：RPC 高频事件输出节流与批量发送策略 | `docs/rpc-server.md`、`docs/vscode-extension.md`、`docs/json-rpc-protocol.md` | 已完成：实时 live event wire 层支持 `agent.eventBatch` 批量发送，VS Code manager 按序分发；Run Log 仍逐事件写入并保持 `seq` 为事实来源，`agent.resume` replay 仍按单事件结构输出。 |
| [x] | P4-6：`agent.cancel` 类型化 helper 与 Chat Cancel UI | `README.md`、`docs/vscode-extension.md`、`docs/json-rpc-protocol.md` | 已完成：新增 `RpcServerManager.cancel()` typed helper、Cancel 按钮和运行中 composer 状态；覆盖 typed cancel RPC 边界测试。 |
| [x] | P4-7：Problems 面板诊断进入 Context Builder | `README.md`、`docs/vscode-extension.md`、`docs/context-capsule.md` | 已完成：VS Code 发送 turn 时采集 Problems 快照，并通过 `agent.sendTurn.attachments` 的 diagnostic attachment 注入；前端按协议 attachment 上限裁剪、优先保留 error，Core/Context Builder 继续负责 attachment 校验和 token 预算。 |
| [x] | P4-8：Terminal command approval | `README.md`、`docs/vscode-extension.md`、`docs/approval-model.md` | 已完成：审批 payload 支持命令、cwd、风险等级、风险原因、上一条 shell 输出摘要字段和 never/session/workspace 持久化语义；P5-2 后 VS Code 主审批弹窗不再暴露复杂持久化选项。 |
| [x] | P4-9：审批持久化存储 | `docs/approval-model.md`、`docs/tool-system.md`、`docs/vscode-extension.md` | 已完成：RPC pending queue 支持 session 内存复用和 workspace `.prole-coder/approvals.v1.json` 存储；继续在 Core 和 RPC 层禁止 network/destructive 风险持久化。 |
| [x] | P4-10：provider、model、预算、审批策略和 RPC 命令配置界面 | `README.md`、`docs/vscode-extension.md` | 已完成：VS Code `ProleCoder: Open Settings` 打开扩展设置，并从 `agent.initialize` ready state 展示 provider、默认模型、context/output budget、模型 capability、审批策略、RPC command/args/autostart 和 state dir；配置贡献只包含非敏感 RPC/FIM 选项，API Key 仍只由 RPC server 环境读取。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。 |
| [x] | P4-11：真实 hunk 级 patch 审批 | `docs/tool-system.md`、`docs/vscode-extension.md`、`docs/json-rpc-protocol.md` | 已完成：首版限定 `apply_patch`，Core 解析 unified diff 生成稳定 hunk id，`ApprovalDecision::ApprovedHunks` 会过滤 patch 后只应用已批准 hunks；RPC pending queue 校验未知、重复、空 hunk 和持久化误用；VS Code modal 提供 selected hunk quick pick；`tool.approvalRequired` / `tool.approvalResolved` 已扩展并纳入协议 fixture。验收：`cargo test -p prole-coder-agent-core filter_apply_patch_hunks_keeps_only_selected_hunks`、`cargo test -p prole-coder-agent-core turn_loop_applies_only_approved_patch_hunks`、`cargo test -p prole-coder-agent-rpc approval_queue_resolves_hunk_level_patch_decisions`、`pnpm -r test`。 |
| [x] | P4-12：FIM completion preview | `README.md`、`docs/deepseek-api-adapter.md`、`docs/vscode-extension.md` | 已完成：新增 `agent.previewFim` RPC 类型、Rust request loop 分发、CLI provider factory FIM preview、DeepSeek beta `/completions` FIM adapter、fixture provider 预览和 VS Code 原生 inline completion provider；前端模型选择只使用 P4-3 capability data 的 `supportsFim`，不靠模型名称推断。验收：`cargo test -p prole-coder-agent-rpc request_loop_handles_fim_preview_requests`、`cargo test -p prole-coder-cli fixture_rpc_provider_factory_returns_fim_preview`、`pnpm -r typecheck`、`pnpm -r test`。 |
| [x] | P4-13：VSIX alpha / pre-release 打包与安装说明 | `docs/release.md`、`docs/vscode-extension.md` | 已完成：新增 `pnpm run vsix:alpha` / `vscode/extension/scripts/packageAlphaVsix.mjs`，构建 protocol 与 extension 后在 `target/vsix/` 保留可安装 pre-release VSIX，并生成 SHA-256 校验和；脚本校验 VSIX manifest 的 pre-release 标记与 publisher/name/version 一致性，`docs/release.md` 记录 clean user-data/extensions 目录安装验收步骤。验收：`pnpm run vsix:alpha`。 |
| [x] | P4-14：补齐 end-to-end 集成测试覆盖 | `README.md`、`docs/vscode-extension.md`、`docs/testing.md` | 已完成：`pnpm run vscode:test-electron` 在隔离 user-data/extensions profile 中启动 VS Code test host，并通过 `vscode/extension/test/fixtures/rpcFixtureServer.mjs` 本地 JSON-RPC fixture 覆盖 extension activation、Chat sendTurn、Problems diagnostic attachments、自动审批回传、Cancel、Run List / resume 和 Chat timeline/submission/context 状态；VSIX 安装后的 clean 环境基础交互继续按 `docs/release.md` 的可重复手动路径验收。 |
## Phase 5：VS Code Codex-like UX 与开发工作流

状态：已完成。P5-1 到 P5-11 已全部完成，覆盖原生 Chat、审批简化、自动上下文、测试验收、Output Channel、API key 配置、错误恢复、只读 Git context 和 GitLens-like commit / PR 文案生成工作流。G4 自动 commit / push / create PR 留作后续增强。

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | P5-1：原生 VS Code Chat Participant `@prole` | `README.md`、`docs/vscode-extension.md` | 已完成：贡献 `contributes.chatParticipants` 和 `vscode.chat.createChatParticipant`，让 `ProleCoder: Open Chat` 优先打开 VS Code 原生 Chat 侧栏并填入 `@prole`；Activity Bar Webview 保留为高级状态面板。验收：`pnpm -r typecheck`、`pnpm -r test`、`pnpm run vscode:test-electron`、`pnpm run vsix:smoke`、`pnpm run vsix:alpha`。 |
| [x] | P5-2：审批 UX 简化 | `README.md`、`docs/approval-model.md`、`docs/vscode-extension.md` | 已完成：主审批弹窗收敛为 Approve / Reject；`apply_patch` 多 hunk 继续提供 Select Hunks quick pick；持久化批准能力保留在后端策略与 RPC 队列，不在主审批弹窗里暴露复杂选项。验收：`commands.test.ts` 覆盖简化 choices、一次性 approve、reject/dismiss 和 hunk 选择。 |
| [x] | P5-3：自动上下文压缩 | `README.md`、`docs/context-capsule.md`、`docs/json-rpc-protocol.md` | 已完成：Sidebar Chat 和原生 Chat Participant 从历史对话/事件流生成受限长度的 `explicit_content` attachment，交给已有 Context Capsule 处理，让连续对话自然承接上下文；Sidebar timeline 单条消息会先限长，避免极端长流式输出造成过大的中间文本。验收：`automaticContext.test.ts` 和 `chatParticipantCore.test.ts` 覆盖压缩、预算裁剪、单条 timeline 消息限长、attachment 合并和 turn runner 注入。 |
| [x] | P5-4：UX 收敛测试与打包验收 | `README.md`、`docs/testing.md`、`docs/release.md` | 已完成：覆盖自动上下文压缩、原生 Chat Participant turn runner、简化审批 choices、extension-host E2E、VSIX smoke/alpha 打包和文档一致性，并补充 Chat Participant 早到 terminal event 缓冲回归测试。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`、`pnpm run vscode:test-electron`、`pnpm run vsix:smoke`、`pnpm run vsix:alpha`、`git diff --check` 和敏感信息扫描。 |
| [x] | P5-5：VS Code Output Channel 错误诊断 | `README.md`、`docs/vscode-extension.md`、`docs/testing.md` | 已完成：插件创建 `ProleCoder` Output Channel，Sidebar Chat 的 sendTurn、Run List refresh/resume/cancel 失败、原生 `@prole` Chat Participant turn 失败以及 RPC 启动/运行 warning 会写入完整日志；activation 层使用统一 notifier 分发 Output Channel 日志与 VS Code toast；侧边栏保留短状态并通过 title 暴露完整文本。验收：`logging.test.ts` 覆盖日志格式与输出分发，`chatParticipantCore.test.ts` 覆盖 RPC 失败写入 logger。 |
| [x] | P5-6：DeepSeek API key SecretStorage 与 provider status | `README.md`、`docs/vscode-extension.md`、`docs/testing.md` | 已完成：新增 `ProleCoder: Configure DeepSeek API Key` / `Clear DeepSeek API Key` / `Show Provider Status` 命令；SecretStorage 优先、process env fallback、missing 明确展示；RPC child env 继承 `process.env` 后覆盖 `DEEPSEEK_API_KEY`，不改变 CLI env 路径。 |
| [x] | P5-7：统一 redaction 与 API key 错误恢复 UX | `docs/vscode-extension.md`、`docs/testing.md`、`docs/security-model.md` | 已完成：在 notifier/logger 边界统一脱敏 SecretStorage/env 中的 key，覆盖 Output Channel、toast 和 RPC startup failure；API key 配置/清除后 idle 状态自动重启 RPC，active run 场景提示当前回合结束后生效。 |
| [x] | P5-8：Git context 只读采集与大 diff attachment 管线 | `docs/vscode-extension.md`、`docs/testing.md`、`docs/context-capsule.md` | 已完成：优先使用 VS Code Git API 采集 repository、branch/upstream 和 staged diff；git CLI 仅作受控 fallback，cwd 来自 repository root；commit/PR 命令把 diff context 作为 `explicit_content` attachment 交给现有 Context Capsule 预算管线。 |
| [x] | P5-9：Generate Commit Message 写入 Source Control inputBox | `README.md`、`docs/vscode-extension.md`、`docs/testing.md` | 已完成：新增命令从 staged diff 生成 Conventional Commit 风格候选 message，并写入 `repository.inputBox.value`；staged 为空时才询问是否使用 unstaged context；不自动 commit。 |
| [x] | P5-10：Generate PR Description markdown 生成 | `README.md`、`docs/vscode-extension.md`、`docs/testing.md` | 已完成：基于 upstream tracking branch、`main`、`master` 或用户选择确定 base，采集 branch diff/stat/commit summary，生成 PR title/body markdown；首版提供有标题的 untitled markdown 预览/复制/打开入口，不自动创建 PR。 |
| [x] | P5-11：Phase 5 UX 工作流验收与文档收敛 | `README.md`、`docs/roadmap.md`、`docs/testing.md` | 已完成：补齐 P5-6 到 P5-10 的单元测试、extension-host 验收、VSIX smoke/alpha 验证和文档一致性检查；Git workflow agent 终态事件已补幂等保护，明确 G4 自动 commit / push / create PR 为后续增强，需要接入审批模型后再做。验收：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`、`pnpm run vscode:test-electron`、`pnpm run vsix:smoke`、`pnpm run vsix:alpha`、`git diff --check` 和敏感信息扫描。 |

## Phase 6：TUI 与生态扩展

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [ ] | TUI RPC 入口和事件流消费 | `README.md`、`docs/tui.md` | 消费 `agent.event`，展示 run、turn、工具和审批状态。 |
| [ ] | TUI Chat / Plan / Diff / Tools / Context / Settings 页面 | `README.md`、`docs/tui.md` | 完整 ratatui 界面仍未实现。 |
| [ ] | TUI hunk 级审批、run resume、配置文件和 release binary | `README.md`、`docs/tui.md` | 建议在 VS Code 核心体验和共享事件管线稳定后推进。 |
| [ ] | 多 active run 与事件订阅模型 | `docs/rpc-server.md`、`docs/turn-loop.md`、`docs/tool-system.md` | 扩展 active run、审批队列、取消句柄和事件订阅模型，支持多个 run 或多个前端并发推进。 |
| [ ] | 更细的 replay 语义 | `docs/rpc-server.md`、`docs/tool-system.md`、`docs/run-log.md` | 明确 resume 时哪些事件原样回放、哪些需要历史标记，并与 pending approval / hunk 审批状态保持一致。 |
| [ ] | MCP client、本地模型/私有推理服务 adapter、包管理器工具、issue/PR 工具、审计包导出 | `docs/roadmap.md` | 生态扩展应在核心闭环、编辑器体验和 DeepSeek 差异化稳定后推进。 |

## Phase 7：发布与治理

| 状态 | 任务 | 来源 | 说明 |
| --- | --- | --- | --- |
| [x] | 许可证策略确定为 AGPL-3.0-or-later | `README.md`、`docs/release.md`、`docs/adr/0003-use-agpl-3.0-or-later.md` | 正式发布文件仍在后续任务。 |
| [ ] | 发布 `LICENSE`、源码获取说明和网络服务源码提供说明 | `README.md`、`docs/release.md` | 发布前必需。 |
| [ ] | 发布源码包、Cargo crate、npm wrapper、VSIX、GitHub Release 校验和 | `README.md`、`docs/release.md` | 需要发布脚本和产物签名/校验策略。 |
| [ ] | 公开 roadmap、issue 模板和贡献流程增强 | `README.md`、`CONTRIBUTING.md` | 面向外部协作者。 |
| [ ] | reproducible build 说明 | `README.md`、`docs/release.md` | 发布可信度要求。 |
