# 审批模型

状态：`0.1.0` 设计已确定，基础类型、Turn Loop 审批编排、RPC pending approval 等待队列、审批超时、取消语义、shell 动态风险升级、workspace-scoped 只读 shell 白名单和 `apply_patch` hunk 级审批已实现。

审批模型用于保护工作区，避免未经审阅的写入、命令执行、网络访问和破坏性操作。审批是 Agent Core 的核心安全边界，不由前端单独实现。

## 风险等级

| 等级 | 英文标识 | 示例 | 默认策略 |
| --- | --- | --- | --- |
| 读取 | `read` | read file、search、git status | 自动允许 |
| 写入 | `write` | apply patch、格式化已跟踪文件 | 工具级策略决定；受限 workspace 小规模代码 `apply_patch` 默认免审批，超过 5 个 `expectedFiles` 或修改 workspace policy 文件仍需审批 |
| 执行 | `exec` | 测试、构建、lint 命令 | 需要审批 |
| 网络 | `network` | 下载依赖、远程 API、远程 git | 需要审批 |
| 破坏性 | `destructive` | 删除、reset、清理未跟踪文件、强制 push | 总是审批 |

默认策略：

```text
read        -> none
write       -> required
exec        -> required
network     -> required
destructive -> always_required
```

风险等级的默认审批只作为基线。工具注册表可以对已受路径沙箱和 schema 约束的工具显式覆盖审批需求：`apply_patch` 仍报告 `write` 风险，但因为只能修改当前 workspace 内、`expectedFiles` 明确列出的文件，所以小规模代码 patch 默认 `approval=none`，不会弹出审批卡片；当 `expectedFiles` 超过 5 个文件，或修改 `.gitignore` / `.prole-coderignore` 这类 workspace policy 文件时，Turn Loop 会动态升级为 `required`。

工具定义中的风险等级是默认风险。Agent Core 可以基于具体参数升级风险；唯一允许的降级例外是 `shell` 的 workspace-scoped 只读白名单命令，这类命令必须没有管道、重定向、变量展开、子命令、绝对路径、父级路径或敏感 workspace 路径。

## 审批要求

审批要求使用三个稳定值：

- `none`：无需审批。
- `required`：每次操作前审批，可以在未来支持安全的 session/workspace 持久批准。
- `always_required`：每次都必须审批，不允许持久化。

`destructive` 风险必须使用 `always_required`。动态升级为 `network` 或 `destructive` 的 shell 命令不会允许持久化审批。

## 审批请求

审批请求必须展示：

- `approvalId`
- `toolCallId`
- 工具名
- 风险等级
- 风险升级原因，例如依赖安装、网络访问、远程 git、删除或发布命令
- 标题
- 详细说明
- 工作目录
- 精确命令或文件路径
- 对 `apply_patch`，可批准 hunk 的稳定 id、文件路径和 hunk 行号范围
- 是否允许持久化

前端只能显示和提交用户决定。Agent Core 负责判断请求是否有效、是否过期、是否可持久化。

## 状态机

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

允许的转换：

| From | To |
| --- | --- |
| `pending` | `approved` |
| `pending` | `rejected` |
| `pending` | `canceled` |
| `pending` | `expired` |
| `approved` | `executing` |
| `executing` | `completed` |
| `executing` | `failed` |

其他转换都是协议错误或内部状态错误。

## 拒绝审批

审批被拒绝时：

- Agent Core 记录拒绝结果。
- 原请求失效。
- Agent Core 不得用相似命令或相同 patch 绕过拒绝。
- Agent Core 只能请求用户选择其他路径、继续只读工作或停止 run。

## 持久化规则

协议 `0.1.0` 中：

- `read` 不需要持久审批。
- `write` 可以支持 session/workspace 持久化，但必须由审批请求显式标记 `persistable: true`；默认免审批的小规模 workspace 代码 `apply_patch` 不产生持久化 approval key。
- `exec` 可以支持 session/workspace 持久化，但必须由审批请求显式标记 `persistable: true`，并由用户选择持久范围。
- `network` 不允许持久化。
- `destructive` 永远不允许持久化。

当前 RPC pending approval queue 已支持 session/workspace 持久批准：session 批准保存在当前 RPC 进程内存中；workspace 批准保存在 workspace 内被忽略的 `.prole-coder/approvals.v1.json`。持久批准 key 首版由工具名、风险等级、命令、cwd 和路径集合组成，不包含 runId/approvalId。动态升级为 `network` 或 `destructive` 的请求会通过 `persistable: false` 防止前端发送持久化批准；RPC 层也会再次拒绝这两类风险的持久化请求。hunk 级 patch 批准是一次性决定，不允许 session/workspace 持久化。

## 实现位置

- Rust：`crates/agent-core/src/approval.rs`、`crates/agent-core/src/command_risk.rs`、`crates/agent-core/src/turn_loop.rs`。
- TypeScript：`packages/protocol/src/index.ts`、`vscode/extension/src/approvalFlow.ts`、`vscode/extension/src/commands.ts`。
- JSON-RPC 事件：`docs/json-rpc-protocol.md` 中的 `tool.requested`、`tool.approvalRequired`、`tool.approvalResolved`、`agent.approve`、`agent.reject`、`agent.cancel`。

当前 Rust 和 TypeScript 已定义风险等级、审批要求、持久化枚举和状态机转换规则。Agent Turn Loop 已能在需要审批的工具执行前写入 `tool.approvalRequired`，根据审批策略等待批准、拒绝、取消、过期或持久批准复用，并写入 `tool.approvalResolved`。受限 workspace 小规模代码 `apply_patch` 默认免审批并直接执行；超过 5 个 `expectedFiles` 的 bulk patch 或 workspace policy 文件 patch 会动态要求审批，hunk metadata 仍保留给高风险 patch 或显式审批路径。CLI 二进制已有 stdin/stderr prompt；`agent-rpc` request loop 已能分发 `agent.approve` / `agent.reject` / `agent.cancel`；`AgentTurnLoopRpcHandler` 已实现单 active run 的 pending approval 队列和 session/workspace 持久批准存储。Agent Core 已在 shell 工具审批前执行命令风险分类：依赖安装、网络访问、远程 git 和发布命令会升级到 `network`，删除、强制 push、git reset/clean 等会升级到 `destructive`，并在 `tool.requested` / `tool.approvalRequired` 中写入 `riskReasons`、`command`、`cwd` 和上一条 shell 输出摘要；严格只读的 `rg`、`Get-Content`、`git diff/status/log/show` 等 workspace-scoped 简单命令会改为 `read` 并免审批。模型 provider request 窗口耗尽时也会通过 `model_turn_budget` 这个 schema-only approval 复用同一 pending queue，批准后继续下一段窗口而不是直接失败。VS Code 插件已有 legacy modal approval adapter 和默认 Sidebar 内联 approval card，并接入真实 RPC pending queue；需要审批的 patch 路径可选择 hunk 后通过 `agent.approve.hunks` 回传，RPC/Core 会校验并只应用已批准 hunks；Sidebar 还支持同一 run 内“本对话批准此命令”的前端级复用，按 `runId + cwd + command` 自动批准后续相同 shell 审批。TUI 已有可测试的 prompt 状态机。

## 后续增强

- 扩展 RPC 审批队列到多 active run、跨进程恢复和前端断连后的自动取消；当前实现只支持单 active run 的内存等待队列。
- 扩展 patch 的动态风险升级；`shell` 的动态风险升级已覆盖下载依赖、访问网络、删除文件、发布和远程 git 操作，只读白名单已覆盖 workspace 内简单读命令，`apply_patch` 已支持超过 5 个文件的 bulk patch、workspace policy 文件动态审批和 hunk 级批准。
- 扩展持久批准的可审计 metadata、清理入口和高级 UI 管理；`network` 和 `destructive` 仍不允许持久化，VS Code 主审批 UI 不重新暴露 session/workspace 选项。
- 继续增强 TUI 的真实 RPC pending 队列接入；VS Code 已能消费 `tool.approvalRequired` 并发送 `agent.approve` / `agent.reject`。
- 增加跨前端一致性测试，确保同一工具请求在 CLI、TUI 和 VS Code 中展示的风险、路径、命令、风险原因和持久化能力语义一致；VS Code 主审批 UI 保持简化的 Approve / Reject。
