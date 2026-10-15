# Codex CLI 适配说明

- 探测命令：`codex`
- 默认调用：`codex exec --skip-git-repo-check --full-auto -`，提示词走标准输入（`-` 表示从标准输入读取）
- `--full-auto`：允许在数据目录内自动写文件、执行命令（沙箱内）
- `--skip-git-repo-check`：数据目录不是 git 仓库，需要跳过检查
- 不支持续接会话：每条消息会附带最近的对话历史

## 常见问题

- **报错参数不认识**：旧版 Codex 可能不支持某些参数，请先升级（`npm i -g @openai/codex`），或在 `bridge.json` 中删掉对应参数。
- **需要联网/控制浏览器**：沙箱默认限制网络，可在 `adapter.args` 中改用 `--sandbox danger-full-access`（先征得用户同意）。
- **未登录**：请用户在终端运行一次 `codex` 完成登录。
