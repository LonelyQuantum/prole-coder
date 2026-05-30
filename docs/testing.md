# 测试协作规范

本项目的测试代码默认进仓库，但不代表所有测试都进入默认 CI。协作时先区分测试目的，再决定放置位置、运行命令和 CI 层级。

## 基本原则

- 默认 CI 只运行确定性、低成本、无密钥、无真实网络依赖的测试。
- 真实 API、模型输出、长上下文、压力测试和展示型 demo 必须显式开启，不能被普通 `cargo test --workspace` 或 `pnpm run check` 自动触发。
- 修复缺陷时应补最小回归测试；如果缺陷来自真实服务或模型行为，应优先把可复现部分抽成离线 fixture。
- 测试不能依赖本机绝对路径、当前 shell 的工作目录、`.secrets/` 或开发者私有配置。
- 多人新增测试时应复用已有 fixture、`agent-core::test_helpers::TestWorkspace`、JSON-RPC event parser 和 run log helper，避免并行维护多套测试替身。

## 测试类型

### 单元测试

用于验证纯逻辑、解析器、状态机、schema、错误码和安全边界。单元测试应靠近被测模块，默认进入 CI。

### 确定性集成测试

用于验证 crate 之间、CLI 二进制、RPC loop、run log、tool execution 等模块协作。应使用 fixture provider、临时目录和固定输入输出，默认进入 CI。

### 回归测试

用于锁住已经修复的问题。回归测试应尽量小，并说明触发条件；只要不依赖网络和密钥，就默认进入 CI。

### 真实联网测试

用于验证 DeepSeek API、真实 streaming、真实 tool call delta 或真实模型工具调用。测试代码可以进仓库，但必须使用 `#[ignore]`，并通过 `PROLE_CODER_LIVE_TESTS=1` 这类环境开关显式启用。

### 结果展示测试

用于把 Agent 运行过程打印给开发者看，例如工具调用、审批、补丁、验证和 run log 汇总。展示测试可以在展示层把连续 `assistant.delta` 拼成易读文本，但不能改变 provider、turn loop、RPC event 或 run log 的真实 streaming 语义。展示测试默认 `#[ignore]`，不进入普通 CI。

### 压力和长上下文测试

用于 1M context、大仓库搜索、长 run log、并发写入或性能边界。默认不进普通 CI，可作为 ignored test、manual workflow、nightly job 或本地专项验收。

## CI 分层

| 层级 | 触发方式 | 允许内容 | 禁止内容 |
| --- | --- | --- | --- |
| 默认 CI | `push`、`pull_request` | fmt、clippy、离线 Rust/TypeScript 测试、确定性 fixture | API key、真实网络、长耗时、人工观察 |
| 本地开发检查 | `pnpm run check` | 与默认 CI 尽量一致 | 私有路径、隐式依赖 `.secrets/` |
| 本地展示 | `cargo demo`、`cargo demo-live` 以及 `docs/demos.md` 中登记的离线展示命令 | 人类可读 transcript、临时工作区输出 | 作为普通 CI 必跑项 |
| 真实验收 | ignored live test 或 manual workflow | DeepSeek API、真实 streaming、真实模型工具调用 | 无开关自动运行 |
| 压力/长上下文 | ignored test、manual/nightly | 大上下文、大仓库、长时间任务 | PR 默认阻塞 |

默认 CI 当前通过 `pnpm run check` 执行。`search` 工具测试会执行 `rg`，因此本机和 CI 都需要安装 ripgrep。

## Phase 4 VS Code extension-host E2E

Phase 4 P4-14 的确定性 VS Code 端到端入口：

```powershell
pnpm run vscode:test-electron
```

该命令会构建 protocol 与 extension，编译 `test/electron/index.ts`，再用 `@vscode/test-electron` 启动隔离的 VS Code test host。`vscode/extension/scripts/runVscodeIntegrationTests.mjs` 会为每轮测试创建独立 `target/vscode-test-user-data-*` 和 `target/vscode-test-extensions-*` profile，避免本机 VS Code 状态或上一轮测试 mutex 影响结果。

测试工作区使用本地 JSON-RPC fixture server，不联网、不读取 API key，也不依赖全局 `prole` 命令。覆盖范围：

- extension activation、trusted workspace、Chat view focus 和命令注册。
- Chat submit turn 通过真实 `RpcServerManager.sendTurn()` 进入 fixture RPC server。
- Problems diagnostics 被采集为 `agent.sendTurn.attachments` 的 diagnostic attachment。
- `tool.approvalRequired` 经过 test-only auto approval requester 回传为真实 `agent.approve`。
- Chat Cancel UI 边界通过真实 `agent.cancel` 请求收口。
- Run List refresh 和 `agent.resume` replay 通过同一 `agent.event` 渲染路径更新 timeline。

test-only command 和 auto approval 同时要求 VS Code `ExtensionMode.Test` 以及 `PROLE_CODER_VSCODE_TEST=1` / `PROLE_CODER_VSCODE_TEST_AUTO_APPROVE=1` 环境变量，普通扩展激活不会注册这些测试入口。

P4-15 到 P4-18 的 Codex-like UX 收敛继续复用这条 extension-host 入口，并补齐以下确定性覆盖：

- `automaticContext.test.ts` 覆盖历史对话压缩、字符预算裁剪、空历史跳过、Sidebar timeline 转换、单条 timeline 消息限长和 attachment 上限合并。
- `chatParticipantCore.test.ts` 覆盖原生 `@prole` Chat Participant turn runner、命令到 run mode 的映射、sendTurn response 前早到事件缓冲、assistant delta streaming、缺少 RPC client 的错误和自动上下文进度提示。
- `commands.test.ts` 覆盖简化后的审批 choices：主弹窗只暴露 `Approve` / `Reject`，`Approve` 映射一次性批准，`apply_patch` 多 hunk 走 `Select Hunks`。
- `test/electron/index.ts` 覆盖 VS Code manifest 中的 `contributes.chatParticipants`，并通过 `ProleCoder: Open Chat` 入口验证原生 Chat 入口不会依赖手动拖动 Activity Bar view。
- `pnpm run vsix:smoke` 和 `pnpm run vsix:alpha` 会校验 VSIX manifest 中的 `onChatParticipant:prole-coder.chatParticipant` activation event 以及 `@prole` Chat Participant 贡献点。

## 新增测试的协作要求

- PR 或提交说明中标明测试类型：unit、integration、regression、live、demo 或 stress。
- 文档或测试注释中给出运行命令；命令较长时优先添加 Cargo alias 或 npm script。
- 默认 CI 测试必须稳定、可重复，并且不读取 `.secrets/`。
- live 测试必须同时满足 `#[ignore]` 和环境变量开关，避免误触发 token 消耗。
- demo 测试必须默认 `#[ignore]`，输出服务于阅读，不承担唯一正确性证明。
- 新 fixture 应优先放在可复用 helper 中；只有某个测试独有的数据才放在测试本地。
- 真实联网测试读取 API key 时应复用 `agent-core::test_helpers::live_api_key`；测试侧优先级为 `PROLE_CODER_DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY`、`.secrets/deepseek-api-key`。

## 合并主线前测试清单

合并 Phase 1 这类阶段性分支前，建议按风险从低到高执行以下清单。默认 CI 必须通过；联网和展示项不阻塞所有 PR，但在阶段合并前应至少由维护者手动跑一轮并记录结果。

### 必跑：默认 CI 等价检查

```powershell
pnpm run check
```

覆盖范围：

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `pnpm -r typecheck`
- `pnpm -r test`

Phase 1 合并前新增的离线验收已经纳入上述默认检查：RPC request loop 会覆盖 pending approval 并发拒绝与 EOF shutdown 取消，CLI `rpc` 会从真实二进制启动 stdio smoke，Rust/TypeScript 会共同校验协议错误码表与 `docs/json-rpc-protocol.md` 一致。

### 必跑：测试清单盘点

```powershell
cargo test --workspace -- --list
```

该命令不执行测试，只列出 Rust 测试和 ignored 测试。阶段合并前用于确认 live/demo/stress 测试仍然按预期标记为 `#[ignore]`。

### 建议：离线展示验收

```powershell
cargo demo
```

该命令不联网，用于人工检查 Agent event transcript、审批、补丁、验证和 run summary 的展示效果。

### 建议：真实 DeepSeek 联网验收

联网验收需要 API key 和 `PROLE_CODER_LIVE_TESTS=1`。阶段合并前建议至少跑以下几类：

```powershell
$env:PROLE_CODER_LIVE_TESTS = "1"
cargo test -p prole-coder-agent-core --test deepseek_api_live -- --ignored --nocapture
cargo test -p prole-coder-cli --test deepseek_cli_live -- --ignored --nocapture
cargo demo-live
```

如果上游服务返回 5xx、524 或限流，应记录为外部服务不稳定，不直接等同于代码回归；同一 commit 可在服务恢复后重跑。

## Phase 2 Context Capsule 验收分层

Phase 2 的默认 CI 应优先覆盖离线、确定性测试：

- `read_file` 摘要元数据：验证完整文件 `sha256`、`sizeBytes`、行范围读取和 JSON camelCase 序列化。
- Context Capsule renderer：验证 `StablePrefix`、`DynamicPrelude`、`TurnSuffix` 三层分组、显式 placement override、`content == rendered` 兼容字段，以及修改 `TurnSuffix` 不改变 `StablePrefix`。
- manifest fixture：固定工作区结构、ignore 规则、`sha256`、`manifestHash`、`maxEntries` 和 omitted reason。
- Context Builder manifest 接入：验证 Turn Loop 自动注入 manifest summary、`context.built` 输出 stable/dynamic/suffix section token、manifest hash 和 omitted reason。
- token estimator metadata：`utf8_bytes` 和校准估算器都必须明确 `exact=false`，不能误报为真实 tokenizer；校准 fixture 覆盖系数、误差和不保存 prompt 原文的边界。
- attachment fixture：file、selection、explicit_content、diagnostic 都能进入 Context Capsule；路径越界、重复 attachment、超大小 selection / explicit content 和 diagnostic 形状错误均有稳定错误。
- provider summary：`provider.completed` 独立记录模型、duration、usage、cache hit/miss 和 streaming 摘要；DeepSeek streaming wrapper 从 include_usage chunk 填充这些字段。
- JSON Schema validation：tool call arguments 在 typed deserialization 前通过 schema validator，未知字段、错误类型、空字符串/空数组等会稳定失败。
- Run Log 体积边界：工具结果、verification 输出和 Run Log payload 共用脱敏/截断函数，并记录 `runLogTruncation`。

以下验收必须保持 ignored/manual，不进入普通 CI：

- DeepSeek cache hit/miss 实验：相同 `StablePrefix` + 不同 user task 的两次请求应记录 cache hit/miss。
- 200K、500K、900K 样例仓库 Context Capsule 生成和 token 预算报告。
- 真实多文件任务展示 manifest、选中文件/诊断、token 预算、provider usage/cache 和最终验证结果。

Phase 2d 的大上下文手动入口：

```powershell
cargo test -p prole-coder-agent-core --test context_capsule_benchmark context_capsule_large_repository_budget_benchmark -- --ignored --exact --nocapture
```

该测试生成 200K、500K、900K 三档确定性样例 Context Capsule，输出 `inputTokens`、section tokens 和 omitted source 数量；默认 CI 只编译 ignored test，不自动执行。

Phase 2c/2d 的 cache usage 手动入口：

```powershell
cargo test -p prole-coder-agent-core --test deepseek_api_live live_cache_usage_summary_smoke_test -- --ignored --exact --nocapture
```

### 可选：合并前人工检查

- 检查 `docs/demos.md` 中的展示命令是否仍能覆盖最新功能。
- 检查 `.github/workflows/ci.yml` 与 `package.json` 的 `check` 脚本是否一致。
- 对本地工作区运行敏感信息扫描，确保没有 API key、本机路径或 `.secrets/` 内容进入可提交文件。
- 查看最新 code review / discussion 文件，确认已接受的问题要么已修复，要么已进入 roadmap。

建议的手动敏感信息检查：

```powershell
git diff --check
git ls-files .env .secrets
rg -n "sk-[A-Za-z0-9_-]+|C:\\User[s]\\|/Users/[^/]+/|/home/[^/]+/|DEEPSEEK_(CODER_)?API_KEY\\s*=" README.md docs crates packages vscode .github .cargo Cargo.toml Cargo.lock package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .env.example .gitignore --glob "!target/**" --glob "!node_modules/**" --glob "!.git/**" --glob "!.secrets/**"
```

如果只命中类似 `<your-deepseek-api-key>` 的占位示例，应在记录中说明；如果命中真实密钥、本机绝对路径或 `.secrets/` 已被 Git 跟踪，必须先处理再合并。

## 文件位置约定

- Rust 单元测试放在对应模块的 `#[cfg(test)]` 中。
- Rust 集成测试放在对应 crate 的 `tests/` 目录。
- 共享 Rust 测试 helper 放在 `crates/agent-core/src/test_helpers/`，跨 crate 测试通过 `prole_coder_agent_core::test_helpers` 复用。
- CLI 展示测试放在 `crates/cli/tests/agent_interaction_demo.rs`。
- TypeScript 单元或协议测试放在对应 package 的 `src/**/*.test.ts` 或现有测试目录。
- 跨语言协议 fixture 放在 `docs/protocol/`，并由 Rust 与 TypeScript 共同校验。

## 展示型 Demo

展示型 demo 的完整清单、运行命令和预期输出见 `demos.md`。`cargo demo`、`cargo demo-live`、`cargo demo-context`、`cargo demo-context-visual`、`cargo demo-truncation`、`cargo demo-schema` 和 `cargo demo-attachment` 均来自 `.cargo/config.toml`；新增或调整展示命令时，应先更新 `demos.md`，并且只在 demo 已实现、可运行后再加入 Cargo alias。

Phase 2e 已补齐 context、truncation、schema、context-visual、attachment，并增强 `demo-live` 的 provider summary 展示。它们仍应默认 ignored，不进入普通 CI 自动执行，作为人工观察和阶段合并前验收入口。
