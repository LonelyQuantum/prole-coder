# ProleCoder

状态：设计草案。`ProleCoder` 是一个 AGPL-3.0-or-later 许可证开源项目，目标是构建一个以 DeepSeek V4 系列 1M 上下文为核心能力的代码 Agent，先提供 CLI 与一等公民级 VS Code 插件，随后补齐 TUI。

本项目不是 DeepSeek 官方项目，也不与 DeepSeek AI 存在从属关系。当前阶段暂不展开商标策略。

## 为什么做

DeepSeek V4 API 当前提供 `deepseek-v4-flash` 与 `deepseek-v4-pro`，支持 1M 上下文、最大 384K 输出、思考模式、Tool Calls、FIM 补全和上下文硬盘缓存。代码 Agent 可以把这些能力组合成一种更适合大仓库的软件维护方式：少做碎片化检索，多做可审计的整仓理解、计划、修改、验证和回放。

DeepSeek-TUI 已经证明了一个方向：终端内的代码 Agent 可以读取代码、编辑文件、运行命令、调用 MCP，并通过沙箱与审批保护用户工作区。本项目会参考它的产品形态和工程边界，但把重点放在以下差异上：

- 1M 上下文优先：把仓库索引、文件正文、变更历史、任务约束和验证记录组织成稳定的长上下文前缀。
- 多前端同核：CLI、TUI、VS Code 插件共享同一个 Agent Core，避免插件版和终端版行为分叉。
- 可复现回合：每一轮模型输入、工具调用、补丁、命令输出和审批结果都进入本地 run log，便于调试、回滚和安全审计。
- 严格工具协议：工具参数使用 JSON Schema，重要工具默认走审批；不依赖隐藏兜底、临时补丁或不可解释的后处理修正。
- 自由软件治理：公开路线图、公开设计记录、无强制 CLA、可复现发布包，鼓励社区 fork 与二次发行。

## 设计原则

- 用户拥有最终控制权：所有文件写入、命令执行、网络访问、依赖安装、git 操作都应可见、可拒绝、可回放。
- 长上下文不是无限信任：1M 上下文用于提供更多证据，不替代测试、类型检查、LSP 诊断和人工确认。
- 显式失败优先：当上下文预算、权限、工具输出或模型响应不满足协议时，系统应停止并报告原因。
- 本地优先：配置、日志、索引和缓存默认保存在用户机器；遥测默认关闭，不收集代码正文。
- 兼容但不绑定：DeepSeek 是第一目标提供商，provider API 保持足够表达性，便于未来适配私有部署、兼容协议和其他模型服务。
- 前端一致：CLI/TUI 与 VS Code 展示同一份计划、同一份 diff、同一套审批与同一份验证状态。

## 许可证策略

`ProleCoder` 使用 `AGPL-3.0-or-later`：

- 允许商业使用、私有部署、修改和再分发。
- 分发修改版时，必须以 AGPL-3.0-or-later 兼容方式提供对应源码。
- 通过网络向用户提供修改版服务时，也必须向这些用户提供对应源码。
- 使用未修改版本作为本地工具不要求公开自己的业务代码或被处理的项目代码。
- 贡献者提交代码时，默认同意其贡献按 AGPL-3.0-or-later 授权。

这个选择的目的不是阻止商业化，而是保证围绕 `ProleCoder` 本身产生的改进继续回到开源生态。

## 总体架构

```text
User
  |
  +-- CLI/TUI -------------------+
  |                              |
  +-- VS Code Extension ---------+--> Agent RPC Server
                                      |
                                      +-- Agent Core
                                      |   +-- Turn Loop
                                      |   +-- Context Builder
                                      |   +-- Tool Registry
                                      |   +-- Approval Engine
                                      |   +-- Run Log
                                      |
                                      +-- Provider Adapters
                                      |   +-- DeepSeek API
                                      |   +-- Local compatible API
                                      |
                                      +-- Workspace Tools
                                          +-- file/read/search/edit
                                          +-- apply_patch
                                          +-- shell
                                          +-- git
                                          +-- lsp diagnostics
                                          +-- mcp tools
```

### 推荐技术栈

- Core：Rust。适合构建跨平台单文件 CLI/TUI、沙箱边界、文件索引、流式解析和可复现发布。
- TUI：`ratatui`。DeepSeek-TUI 也采用终端优先形态，Rust TUI 生态成熟。
- VS Code 插件：TypeScript。插件通过 JSON-RPC 启动并连接 Rust Agent RPC Server。
- 协议：JSON-RPC 2.0 + Server-Sent Events 风格的增量事件，便于终端和 VS Code 共用。
- 存储：本地 `.prole-coder/`，包含配置、索引、run log、token 统计和审批记录。
- 测试：Rust 单元测试、快照测试、集成测试；VS Code 使用 `@vscode/test-electron`。

## 设计文档

详细设计放在 `docs/`，README 保留项目入口、开发环境和大的开发计划。

文档默认使用中文编写。协议方法名、事件名、错误码、命令、许可证标识等需要稳定机器读取或生态通用的内容保留英文，并在必要时附中文说明。

- `docs/architecture.md`：总体架构。
- `docs/roadmap.md`：详细路线图和阶段优先级。
- `docs/phase-tasks.md`：详细任务阶段、状态和来源索引。
- `docs/agent-core.md`：Agent Core 回合与职责。
- `docs/deepseek-api-adapter.md`：DeepSeek API adapter。
- `docs/reasoning-content.md`：`reasoning_content` 状态机。
- `docs/json-rpc-protocol.md`：内部 JSON-RPC 协议。
- `docs/rpc-server.md`：Agent RPC Server stdio 事件桥接。
- `docs/cli.md`：CLI `run` 最小闭环。
- `docs/run-log.md`：本地运行日志。
- `docs/context-capsule.md`：长上下文构建。
- `docs/tool-system.md`：工具系统。
- `docs/approval-model.md`：审批模型。
- `docs/vscode-extension.md`：VS Code 插件设计。
- `docs/tui.md`：TUI 设计。
- `docs/security-model.md`：安全模型。
- `docs/release.md`：发布策略。
- `docs/adr/`：架构决策记录。

## 开发环境配置

`ProleCoder` 采用 Rust + TypeScript 双栈，Rust 负责 Agent Core、CLI/TUI、RPC Server 和本地工具执行，TypeScript 负责 VS Code 插件与编辑器集成。

仓库已经包含 Rust workspace、pnpm workspace、TypeScript 基础配置、VS Code 插件骨架和 `.env.example`。依赖安装需要开发者在本机执行，项目不会提交 `node_modules/`、构建产物、本地缓存或 API Key。

### 基础依赖

- Rust：使用 stable toolchain，项目使用 Rust 2024 edition；MSRV 在首个可运行版本落地后锁定到 `rust-toolchain.toml`。
- Node.js：使用当前 Active LTS 版本，最低要求暂定为 `>= 24`。
- 包管理器：使用 `pnpm`，通过 Corepack 启用。
- Git：用于工作区状态、diff、patch 审计和发布标签。
- ripgrep：搜索工具优先使用 `rg`。
- VS Code：用于插件开发、调试和 `@vscode/test-electron` 集成测试。

### Windows 本机工具安装

Windows 开发机通常已经带有 Git、PowerShell、VS Code 和 Visual Studio Build Tools。先在新的 PowerShell 窗口中确认现有工具，不需要重复安装已经存在的组件。

```powershell
git --version
code --version
cl
rustc --version
cargo --version
node --version
corepack --version
rg --version
```

如果某个命令不存在，按下面对应项补齐。

#### PowerShell

Windows 自带 Windows PowerShell，可以完成本项目开发。推荐使用 PowerShell 7，但不是硬性要求。

缺少 PowerShell 7 时，可用一种方式安装：

- 从 Microsoft Store 搜索 `PowerShell` 安装。
- 从 PowerShell GitHub Releases 下载 Windows x64 MSI 安装包。
- 使用企业软件源提供的 PowerShell 7 安装包。

安装后打开新的终端，确认：

```powershell
$PSVersionTable.PSVersion
```

#### Git

如果 `git --version` 已经可用，保持现状即可。

缺少 Git 时，可用一种方式安装：

- 从 Git for Windows 官网下载安装器，安装时保留默认选项即可。
- 使用企业软件源安装 Git for Windows。
- 使用 `winget install --id Git.Git --source winget`。

安装后打开新的 PowerShell，确认：

```powershell
git --version
```

#### Visual Studio Build Tools

Rust 在 Windows 下默认使用 MSVC 工具链。需要 Visual Studio Build Tools 提供 C/C++ 编译器和 Windows SDK。

如果 `cl` 命令不可用，不一定代表 Build Tools 没装；`cl` 通常只在 Developer PowerShell 里自动进入 PATH。可以从开始菜单打开 `Developer PowerShell for VS 2022` 再执行：

```powershell
cl
```

缺少 Build Tools 或 C++ 工作负载时，可用一种方式安装：

- 打开 Visual Studio Installer，选择 Build Tools 或 Visual Studio，点击 Modify。
- 勾选 `Desktop development with C++`。
- 确认包含 MSVC 编译器、Windows SDK 和 CMake tools for Windows。
- 应用修改并等待安装完成。

安装后重新打开 PowerShell。普通 PowerShell 中 `cargo build` 能调用 MSVC 即可；如果遇到 C++ 链接器错误，再用 `Developer PowerShell for VS 2022` 验证。

#### Rust

可以，从 Rust 官网下载 `rustup-init.exe` 安装是推荐方式。

缺少 Rust 时，可用这一种方式安装：

1. 打开 Rust 官网安装页：https://rustup.rs/
2. 下载 Windows 版 `rustup-init.exe`。
3. 双击运行 `rustup-init.exe`。
4. 选择默认安装，也就是 stable toolchain、MSVC target 和默认 cargo 路径。
5. 安装完成后关闭当前 PowerShell，重新打开一个新的 PowerShell。
6. 确认 Rust 可用：

```powershell
rustc --version
cargo --version
rustup --version
```

如果安装后仍然找不到 `cargo`，检查用户级 `Path` 是否包含：

```text
%USERPROFILE%\.cargo\bin
```

然后安装项目需要的 Rust 组件：

```powershell
rustup default stable
rustup component add rustfmt clippy
```

#### Node.js 和 pnpm

如果 `node --version` 已经显示 `v24` 或更高版本，可以继续使用当前 Node.js。

缺少 Node.js 或版本过低时，可用一种方式安装：

- 从 Node.js 官网下载安装 LTS 版本安装器。
- 使用企业软件源安装 Node.js LTS。
- 使用 `winget install --id OpenJS.NodeJS.LTS --source winget`。

安装后重新打开 PowerShell，确认：

```powershell
node --version
corepack --version
```

pnpm 通过 Corepack 启用，不需要单独全局安装 npm 包：

```powershell
corepack enable
corepack prepare pnpm@10.0.0 --activate
```

确认：

```powershell
pnpm --version
```

#### ripgrep

`ProleCoder` 搜索文件时优先使用 `rg`。

缺少 ripgrep 时，可用一种方式安装：

- 从 ripgrep GitHub Releases 下载 Windows x64 压缩包，解压后把 `rg.exe` 所在目录加入用户级 `Path`。
- 使用 `winget install --id BurntSushi.ripgrep.MSVC --source winget`。
- Rust 已安装后，使用 `cargo install ripgrep`。

安装后重新打开 PowerShell，确认：

```powershell
rg --version
```

#### VS Code

如果 `code --version` 已经可用，保持现状即可。

缺少 VS Code 或 `code` 命令不可用时，可用一种方式处理：

- 已安装 VS Code 但没有 `code` 命令：重新运行 VS Code User Installer 并确认加入 PATH，或手动把 `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin` 加入用户级 `Path`。
- 未安装 VS Code：从 VS Code 官网下载 User Installer 安装，安装时保留加入 PATH 的选项。
- 使用企业软件源安装 VS Code。

确认：

```powershell
code --version
```

### Linux/macOS 工具安装

Linux/macOS 可使用系统包管理器安装 Git、Node.js、ripgrep、C/C++ 编译工具、OpenSSL 头文件和 `pkg-config`，再通过 `rustup` 安装 Rust stable、`rustfmt` 和 `clippy`。

### 项目依赖安装

Rust 当前 scaffold 没有第三方 crate，`cargo build` 可以直接解析本地 workspace。TypeScript 和 VS Code 插件需要安装 npm 依赖：

```powershell
pnpm install
```

`pnpm install` 会生成 `pnpm-lock.yaml`，这个 lockfile 应该提交到仓库，用于锁定 TypeScript、VS Code 类型和插件打包工具版本。

### 环境变量

开发时可以复制 `.env.example` 到 `.env`，用于选择 base URL、模型、本地状态目录和日志级别。`.env` 已被 `.gitignore` 排除。

```powershell
Copy-Item .env.example .env
notepad .env
```

DeepSeek API Key 建议单独放在 `.secrets/deepseek-api-key`。`.secrets/` 已被 `.gitignore` 排除，这个文件只放 key 本身，不放 base URL 或模型名。

也可以在当前 PowerShell 会话中临时设置：

```powershell
$env:DEEPSEEK_API_KEY = "<your-deepseek-api-key>"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
$env:DEEPSEEK_MODEL = "deepseek-v4-pro"
$env:PROLE_CODER_HOME = ".prole-coder"
$env:RUST_LOG = "prole_coder=info"
```

需要用户级持久环境变量时使用：

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<your-deepseek-api-key>", "User")
```

API Key 不应提交到仓库。本项目默认忽略 `.env`、本地缓存、run log 和密钥文件。

### 预期配置文件

```text
.
├── rust-toolchain.toml
├── rustfmt.toml
├── Cargo.toml
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── .editorconfig
├── .env.example
├── crates/
│   ├── agent-core/
│   ├── agent-rpc/
│   ├── cli/
│   └── tui/
├── packages/
│   └── protocol/
└── vscode/
    └── extension/
```

`rust-toolchain.toml` 负责锁定 Rust channel、edition 相关组件和格式化工具；`pnpm-workspace.yaml` 负责管理 VS Code 插件、共享协议包和未来可能的 Web UI 包。

### 常用开发命令

Rust workspace：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace
```

TypeScript workspace，需要先运行 `pnpm install`：

```powershell
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm run vscode:test-electron
pnpm run vsix:smoke
pnpm run vsix:alpha
```

全量检查：

```powershell
pnpm run check
```

首个 MVP 合入前，CI 至少应覆盖 Rust 格式化、Clippy、单元测试、TypeScript lint、TypeScript 类型检查和 VS Code 插件测试。

## 长上下文方案

1M 上下文的价值在于稳定、完整、可复用，而不是把所有文件无序拼接给模型。

### Context Capsule

每次 Agent 回合生成一个 `Context Capsule`：

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

上下文构建必须满足：

- 稳定排序：Context Capsule 使用 `StablePrefix`、`DynamicPrelude`、`TurnSuffix` 三层布局，避免把展示顺序和缓存前缀混为一谈。
- 精确计量：所有片段在进入请求前计算 token 预算，并记录在 run log。
- 明确来源：每段内容带 path、mtime、git object id 或命令 id。
- 边界完整：文件片段按语法单元或整文件进入；不能把函数、类、JSON、Markdown 表格截断成不可解析状态。
- 超预算即停止：如果必要上下文无法纳入预算，回合应报告缺口，让用户选择缩小任务或允许分阶段执行。

### Workspace Manifest

Manifest 是长上下文的骨架。内部使用结构化 JSON 保存，并通过 canonical serialization 计算 `manifestHash`；进入 prompt 时渲染为紧凑、稳定、适合模型阅读的摘要，而不是把完整 JSON 原样塞入上下文。

```json
{
  "manifestVersion": 1,
  "manifestHash": "sha256:...",
  "maxEntries": 500,
  "entries": [
    {
      "path": "src/main.rs",
      "kind": "rust",
      "sizeBytes": 12345,
      "sha256": "...",
      "git": "working-tree"
    }
  ],
  "omitted": [
    {
      "reason": "max_entries_exceeded",
      "count": 42
    }
  ]
}
```

Manifest 还应记录：

- ignore 规则：硬安全排除、默认工程排除、`.gitignore` 和 `.prole-coderignore`。
- 语言与构建系统：package manager、test command、formatter、linter。
- 入口点：bin、library、VS Code extension activation、MCP server。
- 风险标记：大文件、生成文件、锁文件、二进制文件、秘密疑似文件。

### 缓存策略

DeepSeek API 默认支持上下文硬盘缓存。为了提高命中率：

- `StablePrefix` 放系统约束、项目规则、manifest 摘要和固定文件快照。
- `DynamicPrelude` 放 git 变化摘要和当前诊断等每轮常变但全局相关的信息。
- `TurnSuffix` 放用户新消息、选中文件、工具输出和当前计划。
- 每轮记录 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。
- 对大仓库任务优先使用“整仓前缀 + 变更后缀”的回合结构。

## Agent 回合

基础回合如下：

1. 读取任务与工作区状态。
2. 构建 Context Capsule。
3. 调用模型，流式接收 `reasoning_content`、`content` 和 tool calls。
4. 校验 tool call schema。
5. 若工具有风险，进入审批。
6. 执行工具并写入 run log。
7. 根据结果继续子回合，直到生成计划、补丁或最终报告。
8. 运行验证命令。
9. 输出变更摘要、测试结果和残余风险。

思考模式下如果发生工具调用，后续请求必须按 DeepSeek 文档完整回传相关 `reasoning_content`。Agent Core 应把这件事作为协议状态机处理，避免前端各自实现。

## 工具系统

第一阶段内置工具：

- `workspace_manifest`：生成 workspace manifest v0，包含稳定排序文件摘要、`sha256:` manifest hash、git 状态摘要和截断原因。
- `read_file`：读取 UTF-8 文本文件，保留行号，并返回完整文件的 `sha256` / `sizeBytes` 摘要。
- `search`：优先使用 `rg`，记录命令、耗时和匹配数量。
- `apply_patch`：唯一的文本写入入口，记录 patch 与反向 patch。
- `shell`：执行命令，按风险等级审批。
- `git_status` / `git_diff`：只读 git 状态。
- `lsp_diagnostics`：读取 VS Code 或独立语言服务器诊断。
- `plan_update`：记录 Agent 当前计划。

后续扩展：

- MCP client。
- 浏览器自动化工具。
- 包管理器工具。
- issue/PR 工具。
- 本地模型或私有推理服务适配器。

### 工具风险等级

| 等级 | 示例 | 默认行为 |
| --- | --- | --- |
| Read | 读取文件、搜索、git status | 自动允许 |
| Write | apply_patch、格式化当前项目文件 | 展示 diff 后审批 |
| Exec | 测试、构建、lint | 展示命令后审批或按规则允许 |
| Network | 下载依赖、访问远程 API | 明确审批 |
| Destructive | 删除、reset、清理未跟踪文件 | 总是审批，要求展示目标路径 |

## CLI/TUI 体验

MVP 命令：

```bash
prole
prole run "修复 failing tests"
prole rpc
prole plan "给这个仓库加 VS Code 插件"
prole doctor
prole resume <run-id>
prole log <run-id>
```

TUI 页面：

- Chat：对话、流式输出、工具调用。
- Plan：当前计划、状态、验收标准。
- Diff：文件级 diff 与 hunk 审批。
- Tools：命令输出、耗时、退出码。
- Context：token 预算、缓存命中、上下文来源。
- Settings：模型、base URL、审批策略、ignore 规则。

## VS Code 插件方案

VS Code 插件不是简单包一层终端，而是直接复用 Agent Core：

- Sidebar Chat：项目级任务、计划、工具日志。
- Inline Diff：用 VS Code 原生 diff editor 展示补丁。
- Code Actions：对选中代码生成修复、解释、测试、重构计划。
- Diagnostics Loop：读取 Problems 面板，把错误作为上下文。
- Terminal Approval：执行命令前展示 shell、cwd、环境变量差异。
- Workspace Trust：未信任工作区禁用写入和命令执行。
- Settings Sync：模型、base URL、审批策略、上下文预算、排除规则。
- FIM Completion：通过 DeepSeek FIM Beta 提供补全；最大补全长度按官方限制处理。

插件与核心通信：

```text
extension.ts
  -> spawn prole rpc
  -> initialize(workspace, config)
  -> sendUserTurn(...)
  <- stream events: delta, tool_call, approval_required, patch, diagnostics, done
```

## 可参考 DeepSeek-TUI 的地方

- 终端优先：键盘驱动、低依赖、跨平台发布。
- 沙箱与审批：让危险操作进入显式确认流程。
- MCP：把外部能力作为协议化工具，而不是硬编码进主循环。
- 多安装渠道：npm wrapper、Cargo、Homebrew、GitHub Releases、Docker。
- 本地配置：通过用户目录保存 provider、模型、locale、审批策略。

## 本项目要做得不同

- VS Code 首发同级支持，而不是后续附属界面。
- Context Capsule 成为核心数据结构，并在 UI 中展示 token 来源和缓存命中。
- run log 可回放：同一轮请求、工具结果、补丁和验证结果可以导出为审计包。
- 插件、TUI 和自动化模式共用同一套工具权限系统。
- 对自由软件发布更严格：源码、构建脚本、发布校验、贡献规范和安全策略一起发布。
- 更重视中文工作流：中文项目规则、中文 commit/PR 摘要、双语文档和中文错误解释作为内置能力。

## 开发计划

当前进度：Phase 1 到 Phase 4 已完成；Phase 5：VS Code Codex-like UX 与开发工作流仍在进行中。Phase 5 已完成原生 Chat、简化审批、自动上下文压缩、Output Channel、API key/model 配置、Git 工作流、Sidebar 连续会话 / Run 删除 / 折叠事件 UX、结构化 provider 配置错误恢复和真实试用回归修复；P5-15 真实试用 UX backlog 持续收敛仍未完成。完成 P5-15 后再进入 Phase 6：TUI 与生态扩展。

阶段完成口径：README 中某个 Phase 只有在 `docs/phase-tasks.md` 对应 Phase 下的所有任务都标记为 `[x]` 后，才能在高层开发计划中表述为“全部完成”。如果某阶段核心功能已完成但仍有 P1/P2 增强或发布/文档验收项未完成，README 必须继续把该阶段表述为进行中，并列出剩余任务。

### Phase 0：项目章程

- [x] P0-1：项目身份、许可证与治理。
- [x] P0-2：Rust / TypeScript workspace 与基础工程配置。
- [x] P0-3：基础协议、工具 schema、风险等级与审批模型设计。

### Phase 1：Agent Core MVP

- [x] P1-1：DeepSeek provider、streaming 与 reasoning 基础。
- [x] P1-2：基础 Context Builder 与 workspace 工具执行层。
- [x] P1-3：Run Log、Agent Turn Loop 与 CLI/RPC 最小闭环。
- [x] P1-4：Agent RPC Server 与审批前端基础。
- [x] P1-5：合并主线前测试、live 配置、RPC/CLI/protocol 和最终验收收敛。

说明：VS Code RPC server 启动监管与 JSON-RPC request client 已提前完成，归入 Phase 3 前置项；Agent Core MVP 验收不依赖完整 VS Code UI。

细任务维护规则：README 开发计划只保留阶段级和大任务摘要，使用 `P阶段-数字` 编号；每个任务的实现细节、验收命令、审查来源和 `P阶段-数字字母` 子任务拆分统一维护在 `docs/phase-tasks.md`。高层阶段条目标记完成前，必须确认该阶段在 `docs/phase-tasks.md` 的所有子项都已完成。

验收标准：

- 能在一个小型 Rust/TypeScript 项目中读取代码、生成计划、修改文件、运行测试并报告结果。
- 所有写入都经过 patch。
- 所有命令都有 cwd、退出码和输出记录。
- CLI 与 RPC 事件流能从同一份 run log 重建关键过程。

### Phase 2：1M Context Capsule

- [x] P2-1：Context Capsule 数据模型与 Workspace Manifest。
- [x] P2-2：TokenEstimator 与稳定前缀。
- [x] P2-3：Attachments、provider summary 和 cache 实验。
- [x] P2-4：大仓库验收、超预算解释、Run Log 体积控制和 JSON Schema 校验层。
- [x] P2-5：合并主线前展示型 demo 扩展。

验收标准：

- 在 200K、500K、900K token 三档样例仓库上生成可审计 Context Capsule。
- 能展示哪些文件进入上下文、哪些没有进入，以及原因。
- 同一 workspace 的稳定前缀可重复渲染，修改 `TurnSuffix` 不改变 `StablePrefix`。
- 能记录 provider usage、cache hit/miss 和 token estimator 元数据。
- 工具、验证和 provider 相关事件共享 Run Log 脱敏/截断边界，超大输出可通过 `runLogTruncation` 与空输出、缺失字段区分。
- 模型 tool call 参数必须先通过 JSON Schema 校验，未知字段和错误类型不得进入 typed deserialization。
- 合并主线前必须能用展示型 demo 直接观察 Context Capsule、Run Log 截断、tool schema 校验、attachments 和 provider summary。

### Phase 3：VS Code 插件核心与共享 RPC 交互管线

- [x] P3-1：RPC 全双工事件管线与断连取消。
- [x] P3-2：VS Code extension scaffold、RPC server 管理和 JSON-RPC request client。
- [x] P3-3：VS Code/protocol 类型共享与 RPC/commands 边界测试。
- [x] P3-4：Sidebar Chat、真实 sendTurn 和 RPC pending queue 审批。
- [x] P3-5：命令风险、进程树清理、Native diff、Run List/resume 和 Context Capsule 可视化。

验收标准：

- `agent.sendTurn` 创建 run 后返回 accepted，不等待 `assistant.delta`、审批或终端事件。
- 同一 run 的 live `agent.event` notification 与 `agent.resume` replay 都使用 Run Log `seq` 顺序和同一 envelope。
- 关闭 stdin、writer 失败或插件停用会取消 active run，并在 run log 中收口到 terminal event。
- 更强进程树清理策略完成并通过可执行测试或清晰的手动验收说明。已新增 descendant process 取消回归测试。
- Sidebar Chat 能展示 `assistant.delta`、tool lifecycle 和 terminal event；Chat 输入能发送真实 `agent.sendTurn` 并收到最终结果。已完成首版输入发送和事件流收口。
- VS Code 审批 UI 能消费 `tool.approvalRequired`，并把 approve/reject 回传到 `agent.approve` / `agent.reject`。已完成真实 RPC pending queue 接入，当前默认使用 Sidebar 内联审批卡片。
- Sidebar Chat 能展示最近 run 列表，并通过 `agent.resume` 回放历史事件。已完成首版 Run List / resume 接入。
- Sidebar Chat 能可视化 `context.built` 的 token 分段、来源纳入/省略和 manifest/cache/estimator metadata。已完成首版 Context Capsule 可视化。
- `docs/phase-tasks.md` 的 Phase 3 条目全部标记为 `[x]` 后，README 才能把 Phase 3 表述为整阶段完成。当前 Phase 3 已满足该条件。

### Phase 4：VS Code 深度集成

- [x] P4-1：VSIX dry-run packaging smoke。
- [x] P4-2：`@vscode/test-electron` 最小 harness。
- [x] P4-3：Provider capability model data contract。
- [x] P4-4：事件 payload schema 与协议 fixture 对齐。
- [x] P4-5：RPC 高频事件输出节流与批量发送策略。
- [x] P4-6：`agent.cancel` 类型化 helper 与 Chat Cancel UI。
- [x] P4-7：Problems 面板 diagnostics 通过 diagnostic attachments 进入 Context Builder。
- [x] P4-8：Terminal command approval。
- [x] P4-9：审批持久化存储。
- [x] P4-10：provider、model、预算、审批策略和 RPC 命令配置界面。
- [x] P4-11：真实 hunk 级 patch 审批。
- [x] P4-12：FIM completion preview。
- [x] P4-13：VSIX alpha / pre-release 打包与插件安装说明。
- [x] P4-14：补齐 end-to-end 集成测试覆盖。

验收标准：

- 插件不需要用户手动打开终端即可完成一次“诊断 -> 修改 -> 测试 -> 报告”。
- 插件和 CLI 对同一任务产生一致的 run log。
- VS Code 插件可通过 VSIX 安装到 clean 环境。
- fixture provider 下 Chat sendTurn、Cancel、Problems diagnostics、审批和 Run List / resume 至少有一条 extension-host 或可重复手动验收路径。
- 配置界面不保存 API Key，只管理非敏感配置。
- `docs/phase-tasks.md` 的 Phase 4 条目已全部标记为 `[x]`，README 可以把 Phase 4 表述为整阶段完成。

### Phase 5：VS Code Codex-like UX 与开发工作流

- [x] P5-1：原生 VS Code Chat Participant `@prole`。
- [x] P5-2：简化审批 UX。
- [x] P5-3：自动上下文压缩。
- [x] P5-4：UX 收敛测试与打包验收。
- [x] P5-5：VS Code Output Channel 错误诊断。
- [x] P5-6：DeepSeek API key SecretStorage、model selector 与 provider status。
- [x] P5-7：统一 redaction 与 API key 错误恢复 UX。
- [x] P5-8：Git context 只读采集与大 diff attachment 管线。
- [x] P5-9：Generate Commit Message 写入 Source Control inputBox。
- [x] P5-10：Generate PR Description markdown 生成。
- [x] P5-11：Phase 5 UX 工作流验收与文档收敛。
- [x] P5-12：Sidebar 连续会话、Run 删除与折叠事件 UX。
- [x] P5-13：结构化 provider 配置错误码与恢复动作。
- [x] P5-14：真实试用回归修复包：收敛 Sidebar 对话视图、内联确认、Work log 折叠、Markdown 渲染、webview 渲染诊断、provider/shell 稳定性和 composer / Settings 入口回归；具体子项与完成口径见 `docs/phase-tasks.md`。
- [ ] P5-15：真实试用 UX backlog 持续收敛：继续收集并拆分真实 VS Code 插件试用中的对话、审批、Runs、Key/Model、Output 日志、上下文压缩、Markdown 兼容性和大工具参数稳定性问题。

验收标准：

- `ProleCoder: Open Chat` 优先打开 VS Code 原生 Chat 并填入 `@prole`，用户无需手动拖动 Activity Bar view 到右侧。
- 原生 Chat 和 Sidebar Chat 都通过真实 `agent.sendTurn` 驱动回合，并继续复用 Problems diagnostics、审批回传、Cancel、Run Log 和 Context Capsule。
- 连续对话会自动生成可审计、受限长度的上下文压缩 attachment；不会在 UI 文案里要求用户手动重开对话来延续上下文。
- 主审批保持简单并默认在 Sidebar 内联卡片中完成；Sidebar 提供右上角 Settings 齿轮以及 Key/Model 直接入口，过程事件默认折叠，完整事件和错误诊断可在 `Output > ProleCoder` 查看。
- `docs/phase-tasks.md` 的 Phase 5 仍有 P5-15 未完成，README 不能把 Phase 5 表述为整阶段完成；G4 自动 commit / push / create PR 仍是后续增强。

### Phase 6：TUI 与生态扩展

- [ ] P6-1：TUI RPC 入口、事件流消费和核心页面。
- [ ] P6-2：TUI hunk 级审批、run resume、配置文件和 release binary。
- [ ] P6-3：多 active run、replay 语义和事件订阅模型。
- [ ] P6-4：生态扩展：MCP client、本地模型/私有推理服务 adapter、包管理器工具、issue/PR 工具和审计包导出。

### Phase 7：自由软件发布

- [x] P7-1：许可证策略确定。
- [ ] P7-2：发布法律/源码提供文件。
- [ ] P7-3：发布产物、校验和与源码包。
- [ ] P7-4：公开 roadmap、issue 模板和贡献流程增强。
- [ ] P7-5：reproducible build 说明。

## 安全与注意事项

- API Key 只能从环境变量、VS Code SecretStorage 或系统密钥链读取，不能进入 run log。
- 默认排除 `.env`、密钥、证书、浏览器配置、包管理器 token 和大型二进制文件。
- 运行命令前展示 cwd、命令、环境变量差异和风险等级。
- Windows、Linux、macOS 的沙箱能力不同，必须分别实现和测试。
- 不自动执行 `git reset`、删除文件、修改远程分支、发布包或上传数据。
- 不把模型输出当作可信 JSON；所有 tool call arguments 在执行前验证 schema。
- FIM 补全是 Beta 能力，且最大补全长度有限，不能把它当成大规模重构工具。
- DeepSeek 价格、模型名、折扣和 Beta 能力可能变化，README 中的数字只作为设计依据，最终以官方文档为准。
- DeepSeek V3.2 开源权重使用 MIT 许可证；API 使用还受 DeepSeek 平台条款约束。本项目 AGPL 许可证只覆盖本项目代码。
- VS Code Marketplace 发布需要遵守 Microsoft Marketplace 规则；自由软件源码发布不等于自动上架成功。

## 配置草案

```toml
[provider]
name = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
thinking = "enabled"
reasoning_effort = "max"

[context]
max_input_tokens = 1000000
stable_prefix = true
record_cache_usage = true

[approval]
write = "ask"
exec = "ask"
network = "ask"
destructive = "always_ask"

[workspace]
state_dir = ".prole-coder"
respect_gitignore = true
```

## 当前目录结构

```text
.
├── Cargo.toml
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── package.json
├── pnpm-workspace.yaml
├── rust-toolchain.toml
├── rustfmt.toml
├── SECURITY.md
├── tsconfig.base.json
├── .github/
│   └── workflows/
│       └── ci.yml
├── crates/
│   ├── agent-core/
│   ├── agent-rpc/
│   ├── cli/
│   └── tui/
├── docs/
│   ├── adr/
│   ├── README.md
│   ├── architecture.md
│   ├── roadmap.md
│   ├── agent-core.md
│   ├── deepseek-api-adapter.md
│   ├── reasoning-content.md
│   ├── json-rpc-protocol.md
│   ├── rpc-server.md
│   ├── cli.md
│   ├── run-log.md
│   ├── context-capsule.md
│   ├── tool-system.md
│   ├── approval-model.md
│   ├── vscode-extension.md
│   ├── tui.md
│   ├── security-model.md
│   └── release.md
├── packages/
│   └── protocol/
├── vscode/
│   └── extension/
└── README.md
```

后续实现阶段再补充 `examples/`、`tests/` 和发布脚本目录。

## 参考资料

- DeepSeek API 快速开始：https://api-docs.deepseek.com/
- DeepSeek 模型与价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- DeepSeek 思考模式：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- DeepSeek Tool Calls：https://api-docs.deepseek.com/zh-cn/guides/tool_calls
- DeepSeek 上下文硬盘缓存：https://api-docs.deepseek.com/zh-cn/guides/kv_cache
- DeepSeek FIM 补全：https://api-docs.deepseek.com/zh-cn/guides/fim_completion
- DeepSeek Agent 工具接入：https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code
- DeepSeek-TUI：https://github.com/Hmbown/deepseek-tui
- DeepSeek-TUI 官网：https://deepseek-tui.com/en
- DeepSeek 集成列表：https://github.com/deepseek-ai/awesome-deepseek-integration
