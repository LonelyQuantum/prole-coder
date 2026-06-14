# 安全模型

状态：草案。

`ProleCoder` 可以读取代码、写入文件、执行命令、调用模型提供商并展示生成的 patch。安全模型把模型输出和工作区内容都视为不可信输入。

## 边界

- API Key 不得进入 run log。
- VS Code 插件中的 DeepSeek API key 存入 SecretStorage；多 key 管理器只展示 alias 与 masked key，支持选择 active key、修改 alias 和删除指定 key，优先级高于进程环境变量；传给 RPC 子进程时只通过 child env 覆盖 active `DEEPSEEK_API_KEY`。DeepSeek model ID 不是密钥，可通过 VS Code 普通设置保存，并在 child env 中覆盖 `DEEPSEEK_MODEL`。
- `.env` 和本地状态必须被 git 忽略。
- tool call 执行前必须校验 schema。
- 写入应通过 patch application。
- 破坏性操作必须显式审批。
- 网络访问必须显式审批。

## 威胁

- 源码中的 prompt injection。
- 密钥通过日志或 prompt 泄漏。
- tool-call 参数伪造。
- 路径穿越到 workspace 外部。
- 未审阅的命令执行。
- 发布或 CI 依赖中的供应链风险。

## 初始缓解措施

- 显式审批模型。
- 结构化工具 schema；Phase 2d 起，模型 tool call arguments 会在 typed deserialization 前按 JSON Schema 校验。
- 带基础脱敏和大小截断策略的本地 run log。
- 工具结果进入 run log 或 prompt 前可通过统一入口转为已脱敏、已截断 JSON；截断边界通过 `runLogTruncation` 记录。
- 写入前检查 workspace 路径。
- 命令类工具取消或超时时清理子进程树；Unix 使用独立 process group，Windows 使用新 process group、ParentProcessId descendant 枚举和 `taskkill /T /F` 兜底。
- VS Code 插件统一在 notifier/logger/command warning 边界对 SecretStorage/env API key 脱敏，覆盖 Output Channel、toast、RPC startup failure 和 Git workflow generation failure。
- CI 检查格式、lint、测试和类型。

## 后续增强

- 扩展统一脱敏层，覆盖更多 API Key 形态、证书、前端历史回放和 provider 错误正文。
- 为敏感路径建立三层拒绝/忽略规则：硬安全排除默认覆盖 `.env`、`.secrets/`、`.secret/`、`.git/`、`.agents/`、证书、token 文件和常见云服务凭据，不能被用户 ignore 规则重新纳入；默认工程排除覆盖 `target/`、`node_modules/`、`dist/`、`build/`；用户上下文排除使用 `.gitignore` 和 `.prole-coderignore`。
- 持续扩展命令风险分类器覆盖面；当前已在审批前识别网络访问、依赖安装、发布、远程 git 操作、删除和 reset 等高风险行为。
- 按平台实现并测试更强 sandbox 边界；Windows、Linux 和 macOS 的能力差异需要在文档和测试中分别说明。
- 在发布前增加敏感信息扫描、依赖审计和产物校验，确保本地路径、API Key 和临时文件不会进入源码包或 VSIX。
