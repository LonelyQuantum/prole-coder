# 发布策略

状态：草案。

`ProleCoder` 是 `AGPL-3.0-or-later` 自由软件。发布流程应清楚说明源码可获得性和构建可复现性。

## 发布产物

计划产物：

- 源码归档
- Rust CLI/TUI 二进制
- npm wrapper package
- VS Code `.vsix`
- 校验和
- release notes

## 要求

- 每个二进制或打包发布都要提供对应源码。
- 包含 `LICENSE`。
- 为网络服务部署提供源码获取说明。
- 提交 `Cargo.lock` 和 `pnpm-lock.yaml`。
- 稳定发布前提供可复现构建说明。

## 渠道

初始发布渠道可以包括：

- GitHub Releases
- 当 crate 准备好公开使用后发布到 Cargo
- 用于安装 wrapper 的 npm package
- VS Code Marketplace 或 Open VSX

## VSIX dry-run packaging smoke

Phase 4 P4-1 已提供 VSIX 打包烟测入口：

```powershell
pnpm run vsix:smoke
```

该命令会构建 `@prole-coder/protocol` 与 `prole-coder-vscode`，在 `target/` 下临时生成 VSIX，检查 `.vscodeignore`、`workspace:*` 依赖是否只停留在开发期、`media/prole-coder-view.svg`、compiled `out/`、activationEvents、`@prole` Chat Participant 贡献点和包内排除规则，然后清理临时产物。

此 smoke 使用 dry-run 口径，允许缺少 repository 和发布许可证文件，并禁用依赖探测以避免把 workspace 开发依赖写入运行时包。它只验证打包基础设施，不代表 P4-13 的 alpha / pre-release VSIX 安装交付已经完成。

## VSIX alpha / pre-release 打包

Phase 4 P4-13 提供保留产物的 alpha / pre-release VSIX 打包入口：

```powershell
pnpm run vsix:alpha
```

该命令会构建 `@prole-coder/protocol` 与 `prole-coder-vscode`，然后生成：

```text
target/vsix/prole-coder-vscode-0.1.0-alpha.vsix
target/vsix/prole-coder-vscode-0.1.0-alpha.vsix.sha256
```

`vscode/extension/scripts/packageAlphaVsix.mjs` 使用 `@vscode/vsce` 的 `preRelease: true` 打包选项，保留 `package.json` 中的稳定版本号，并通过文件名中的 `alpha` 标识渠道。脚本会校验 VSIX manifest 中的 VS Code pre-release 标记、publisher/name/version 一致性、`onChatParticipant:prole-coder.chatParticipant` activation event 和 `@prole` Chat Participant 贡献点，并写出 SHA-256 校验和。产物位于被忽略的 `target/vsix/`，不提交到仓库。

当前 alpha VSIX 用于本地安装和 clean 环境验收，不等同于 Marketplace / Open VSX 发布。正式对外发布前仍需在 Phase 6 补齐 `LICENSE` 文件、源码获取说明、发布 notes、公开 release checksum 和可复现构建说明。

## VSIX clean 环境安装验收

在新的 PowerShell 中从仓库根目录执行：

```powershell
$userDataDir = Join-Path (Get-Location) "target\vscode-clean-user-data"
$extensionsDir = Join-Path (Get-Location) "target\vscode-clean-extensions"
New-Item -ItemType Directory -Force -Path $userDataDir, $extensionsDir | Out-Null
code --user-data-dir $userDataDir --extensions-dir $extensionsDir --install-extension .\target\vsix\prole-coder-vscode-0.1.0-alpha.vsix --force
code --user-data-dir $userDataDir --extensions-dir $extensionsDir .
```

如果本机没有全局 `prole` 命令，可在这个 clean VS Code 环境中把扩展设置为开发期 RPC 命令：

```json
{
  "prole-coder.rpc.command": "cargo",
  "prole-coder.rpc.args": ["run", "-p", "prole-coder-cli", "--", "rpc"]
}
```

验收时确认：

- `code --user-data-dir $userDataDir --extensions-dir $extensionsDir --list-extensions` 能看到 `prole-coder.prole-coder-vscode`。
- 打开仓库后 ProleCoder Activity Bar 高级面板可见，VS Code 原生 Chat 中可用 `@prole` Chat Participant。
- `ProleCoder: Open Chat` 优先打开 VS Code 原生 Chat 侧栏并填入 `@prole`，同时在受信任 workspace 中按配置静默启动或复用 RPC server。
- `ProleCoder: Open Settings` 能打开扩展设置；API Key 不写入 VS Code settings，只通过 RPC server 的环境变量或被忽略的本地密钥文件读取。
- 完成验收后可删除 `target/vscode-clean-user-data` 和 `target/vscode-clean-extensions`。

## 后续增强

- 添加 `LICENSE` 文件，并在发布包中包含 AGPL-3.0-or-later 许可证文本和源码获取说明。
- 设计可复现构建流程，记录 Rust、Node.js、pnpm、VSIX 打包工具和平台目标版本。
- 增加发布前检查：格式、lint、测试、敏感信息扫描、依赖审计、产物校验和变更日志生成。
- 为 CLI/TUI 二进制、npm wrapper 生成校验和，并把 VSIX alpha 已生成的校验和纳入正式 GitHub Release 发布流程。
- 明确网络服务部署场景下的源码提供方式，避免 AGPL 合规说明留到发布后补救。
