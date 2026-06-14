# CLI

状态：`0.1.0` Phase 1 `run` 最小闭环、`rpc` stdio 入口、`--json` 实时事件输出和 JSON-RPC 错误输出已实现。

CLI 是最小可运行入口。它不重新实现 Agent Core，而是负责解析命令行参数、创建 run log、选择 provider、驱动 `AgentTurnLoop`，并把结果以人类可读摘要或 newline-delimited JSON-RPC 输出。

## 当前命令

```powershell
prole run [options] <task>
prole rpc [options]
```

常用参数：

- `--workspace <path>`：workspace root，默认当前目录。
- `--provider <deepseek|fixture>`：provider 类型，默认 `deepseek`。
- `--fixture <final|readme|patch|shell>`：fixture provider 的确定性脚本。
- `--mode <plan|edit|review|ask>`：Agent run mode。
- `--run-id <id>` / `--turn-id <id>`：显式指定本地 run/turn id。
- `--auto-approve` / `-y`：允许需要审批的工具执行。默认在 CLI 二进制中交互式询问；如果 stdin 已关闭或不可读，则拒绝该审批。
- `--verify <command>`：回合成功后运行显式验证命令。因为它执行 shell command，必须同时传 `--auto-approve`。
- `--json`：输出 newline-delimited JSON-RPC。成功执行中输出 `agent.event` notifications；失败时最后输出 JSON-RPC error response。
- `--max-input-tokens <n>`、`--max-model-turns <n>`、`--max-output-tokens <n>`：预算与轮次窗口。`--max-model-turns` 默认 50，表示每次继续审批前最多允许多少次 provider request；达到窗口后会通过审批继续，而不是直接 `E_MAX_MODEL_TURNS` 失败。DeepSeek 默认输出上限为 65536 tokens，可按需要显式覆盖。
- `--thinking <enabled|disabled>`：控制 DeepSeek thinking mode，默认 `enabled`。

`rpc` 子命令使用同一套 provider 相关参数：

- `--provider <deepseek|fixture>`
- `--fixture <final|readme|patch|shell>`
- `--max-input-tokens <n>`、`--max-model-turns <n>`、`--max-output-tokens <n>`；`--max-model-turns` 是继续审批前的 provider request 窗口，默认 50；DeepSeek 默认 `--max-output-tokens` 为 65536，避免真实项目修复时过早触发模型输出长度截断。
- `--thinking <enabled|disabled>`

`prole rpc` 从 stdin 读取 newline-delimited JSON-RPC request，并把 response / `agent.event` notification 写到 stdout。它当前接入 `AgentTurnLoopRpcHandler`：`agent.sendTurn` 会创建 run log、启动后台 Turn Loop worker，并立即返回 accepted；后续事件由全双工 live event queue 持续输出。`agent.approve` / `agent.reject` 会唤醒 pending approval 队列并继续输出后续事件。显式取消、审批过期、EOF shutdown 取消和 writer failure 断连取消已实现。

## Provider

### `deepseek`

默认 provider。它读取 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL`，通过现有 DeepSeek API adapter 发起 streaming chat completion。CLI 为整个 run 创建一个专用的 Tokio current-thread runtime，并启用 I/O 与 timer driver；当前 CLI 每次只驱动一个 run，这比 multi-thread runtime 更贴合串行命令行场景。

CLI DeepSeek provider 会把 streaming chunk 聚合成 Turn Loop 需要的完整 `Completed` 响应，同时把 content delta 转成 `AssistantDelta` 事件。`reasoning_content` delta 不作为用户可见输出写入 `assistant.delta`，只聚合后用于 thinking + tool calls 的 replay 校验。tool call delta 通过 adapter 的 `ChatToolCallAccumulator` 按 `index` 严格拼装：arguments 逐片追加，id、type 和 function name 必须在 stream 结束前出现且不能冲突。

当前 CLI provider 会把 executor 已实现的工具注册给模型：

- `workspace_manifest`
- `read_file`
- `search`
- `apply_patch`
- `shell`
- `git_status`
- `git_diff`

`lsp_diagnostics`、`plan_update` 和用于本地继续审批的 `model_turn_budget` 仍是 `schema_only`，不会暴露给 CLI 默认 provider。

### `fixture`

fixture provider 不联网，用于本地 smoke test 和 CI。它使用确定性的响应队列，每次 provider 请求弹出一条响应；脚本耗尽时显式失败，便于发现 Turn Loop 的异常重试或轮次配置问题。

- `final`：直接返回最终消息。
- `readme`：请求 `read_file README.md`，随后返回最终消息。
- `patch`：请求免审批 `apply_patch` 修改 `CLI_SMOKE.txt`，随后返回最终消息。
- `shell`：请求 `shell` 执行确定性 echo 命令，用于审批 smoke test。

`shell` fixture 会触发命令审批。交互式运行时可以直接输入 `y` 批准；自动化测试或非交互脚本可以使用 `--auto-approve`。普通 workspace `patch` fixture 不再触发审批。

## 输出

默认输出人类可读摘要：

```text
runId: run_...
turnId: turn_1
events: <workspace>/.prole-coder/runs/<runId>/events.jsonl
status: completed
iterations: 2
tools: 1
final: ...
```

`--json` 输出与 RPC Server 相同的 `agent.event` notification，每行一条 JSON。事件在写入 run log 后立即输出，CLI 不再等 run 完成后批量回放：

```json
{"jsonrpc":"2.0","method":"agent.event","params":{"seq":1,"time":"...","type":"run.started","runId":"run_...","payload":{}}}
```

这让 CLI、TUI、VS Code 可以从同一份 run log 重建关键过程。输出顺序与本地 `events.jsonl` 的 `seq` 顺序一致；如果使用 streaming provider，`assistant.delta` 会在执行中持续出现。

如果 `run --json` 失败，CLI 会在 stdout 写入一行 JSON-RPC error response，并保留非零退出码。该 error response 使用固定 `id: "cli.run"`，`error.code` 复用 `docs/json-rpc-protocol.md` 的错误码，`error.data` 至少包含：

```json
{
  "symbolicCode": "E_APPROVAL_REJECTED",
  "kind": "turn",
  "runId": "run_...",
  "turnId": "turn_1"
}
```

对于命令行参数错误，如果 CLI 能在解析前识别到 `run --json`，也会输出同样格式的 JSON-RPC error response，但不会包含 `runId` / `turnId`。交互式审批提示仍写入 stderr，不会混入 stdout。

## 验证命令

`--verify` 是显式用户命令，不由模型自动生成。CLI 会写入：

- `verification.started`
- `verification.completed`

命令失败时，CLI 返回非零错误，并保留 run log 事件。

`verification.completed` 中的 `stdout` / `stderr` 会在写入 run log 前经过与工具结果相同的脱敏处理。验证命令仍由用户显式提供；如果命令输出中包含 API key、token 或类似 `sk-...` 的密钥片段，本地事件流中只保留 `<redacted>`。

## 交互式审批

CLI 二进制默认会在 `shell` 等需要审批的工具执行前向 stderr 输出审批摘要，并从 stdin 读取 `y` / `n`。最多 5 个 `expectedFiles` 的普通 workspace 代码 `apply_patch` 默认免审批；超过阈值的 bulk patch、workspace policy 文件 patch、高风险 patch 或显式审批路径仍复用同一审批事件。stdout 在 `--json` 模式下仍只保留 newline-delimited JSON-RPC 事件或错误响应，便于前端或脚本解析；人类提示不会混入 stdout。

批准后，Run Log 会出现 `tool.approvalResolved`，随后进入 `tool.started`。拒绝后，Run Log 会出现 `tool.approvalResolved` 和 `run.failed`，对应工具不会执行。

## 当前限制

- CLI DeepSeek provider 已能聚合 streaming tool call delta；`live_deepseek_cli_real_repo_acceptance_test` 已作为 ignored live test 覆盖真实写入、验证和 run log，并已在 Windows 本机通过。
- verification 只支持用户显式提供的单条 shell command。
- `rpc` 子命令已接入 `agent-rpc` 全双工 request loop、真实 pending approval 队列、active run 断连取消和命令子进程树清理；后续仍需要输出节流、多 active run 和更强 sandbox。
- 如果 fixture 场景继续增加，应把 CLI fixture 与 `agent-core` 的 scripted provider 抽成共享测试 harness，减少两套测试替身并行维护。

## 本地 smoke test 示例

无 API key 的确定性读文件：

```powershell
prole run --provider fixture --fixture readme --mode ask "Read README"
```

确定性 patch + verification：

```powershell
Set-Content CLI_SMOKE.txt "old"
prole run --provider fixture --fixture patch --auto-approve --verify "if ((Get-Content CLI_SMOKE.txt -Raw).Trim() -ne 'new') { exit 1 }" "Patch smoke file"
```

输出 JSON-RPC event notifications：

```powershell
prole run --provider fixture --fixture readme --json "Read README"
```

仓库测试中已经包含进程级 fixture smoke test，会从编译出的 `prole` 二进制启动，验证 `--json` 输出和 run log 都包含关键事件，且 JSON event 的 `seq` 连续递增并保持 `run.started -> turn.started -> context.built -> provider.requested -> tool.requested -> tool.started -> tool.completed -> provider.requested -> assistant.delta -> run.completed` 的核心顺序。

真实 DeepSeek provider：

```powershell
prole run --provider deepseek --mode ask "Summarize this workspace"
```

## Agent 交互演示测试

如果想直接观察 Agent 的交互过程，可以运行结果展示型 integration test。它会把 JSON-RPC event 转成人类可读转录，并打印最终文件内容和 `summary.json`。测试分组约定见 `testing.md`，完整 demo 清单见 `demos.md`。

本地 fixture 演示不联网，稳定展示工具调用、审批、补丁、验证和 run log：

```powershell
cargo demo
```

真实 DeepSeek 演示默认 ignored，需要显式开启 live tests：

```powershell
$env:PROLE_CODER_LIVE_TESTS = "1"
cargo demo-live
# 更长且带随机 seed 的真实对话展示：
cargo demo-live-random
```

该演示默认使用项目默认模型 `deepseek-v4-pro`，以提高工具参数遵循度；需要临时改模型时可以设置 `PROLE_CODER_DEMO_MODEL`。

演示测试默认使用临时工作区并在结束后清理。如果需要保留工作区继续查看文件和 run log，可以先设置：

```powershell
$env:PROLE_CODER_KEEP_DEMO_WORKSPACE = "1"
```

真实 DeepSeek streaming 验收：

```powershell
$env:PROLE_CODER_LIVE_TESTS = "1"
cargo test -p prole-coder-cli --test deepseek_cli_live live_deepseek_cli_streaming_smoke_test -- --ignored --exact --nocapture
```

该测试会从编译出的 `prole` 二进制启动真实 `deepseek` provider，使用 streaming completion，并断言 JSON event 中存在 `stream: true` 的 `assistant.delta` 和最终 `run.completed`。模型默认使用项目默认的 `deepseek-v4-pro`；如果要临时改为其他模型，可以在当前 shell 设置 `DEEPSEEK_MODEL`。测试侧 API Key 来自 `PROLE_CODER_DEEPSEEK_API_KEY`、`DEEPSEEK_API_KEY` 或被忽略的 `.secrets/deepseek-api-key`；启动 CLI 子进程时仍会注入运行时 provider 使用的 `DEEPSEEK_API_KEY`。

当前已在 Windows 本机通过该 live smoke test。普通文本 streaming 由 CLI 二进制测试覆盖；真实 tool call delta 形态由 `agent-core` 的 `live_streaming_tool_call_accumulator_smoke_test` 覆盖。

小型真实仓库 CLI 验收：

```powershell
$env:PROLE_CODER_LIVE_TESTS = "1"
cargo test -p prole-coder-cli --test deepseek_cli_live live_deepseek_cli_real_repo_acceptance_test -- --ignored --exact --nocapture
```

该测试会创建一个临时 Rust 仓库，通过真实 CLI 启动 DeepSeek provider，要求模型读取文件、使用 `apply_patch` 修改 `src/lib.rs`，随后由 harness 运行 `cargo test --quiet` 并校验 JSON event 与 run log。测试默认使用 `deepseek-v4-flash`，也可以通过 `DEEPSEEK_CLI_ACCEPTANCE_MODEL` 单独覆盖，避免被普通 `DEEPSEEK_MODEL` 配置影响。当前已在 Windows 本机通过。若 DeepSeek 返回 524，应视为上游网关超时或服务繁忙，先暂停重试；adapter 默认 HTTP timeout 已长于该窗口，单纯加长本地等待时间通常不能解决。
