# Claude Code 适配说明

- 探测命令：`claude`
- 默认调用：`claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools WebSearch,WebFetch --add-dir <技能包目录>`，提示词走标准输入
- 默认放行：改文件（acceptEdits）、网页搜索与读取（选题找热点、对标拆解需要）
- 支持续接会话：工作台会记录 Claude Code 返回的 session_id，同一个网页对话里的后续消息用 `--resume` 续接，上下文不丢失
- 工具调用（读写文件、执行命令）会实时显示在网页对话气泡里

## 权限说明

`acceptEdits` 允许自动修改文件，`--allowedTools` 放行了网页搜索和读取；执行命令、控制浏览器等工具在无界面模式下仍会被拒绝。需要让网页里的任务能执行命令或控制浏览器时，在 `~/XHS-Workbench/config/bridge.json` 的 `adapter.args` 中：

- 精确放行：在 `--allowedTools` 后面的值里追加，如 `"WebSearch,WebFetch,Bash(node:*)"`
- 完全放行：把 `"acceptEdits"` 改为 `"bypassPermissions"`（agent 将无需确认执行任何操作，务必先征得用户同意）

## 启用浏览器控制（自动发布 / 抓评论 / 抓数据需要）

运行 `node scripts/workbench.mjs browser-setup`（先不加 `--yes`，查看将要做的修改并征得用户同意，再加 `--yes` 执行）：

| 方式 | 命令 | 特点 |
|---|---|---|
| Playwright MCP（默认） | `browser-setup --yes` | 独立的浏览器资料目录 `~/XHS-Workbench/browser-profile`，第一次需要用户在 agent 打开的窗口里登录小红书；之后保持登录 |
| Claude in Chrome | `browser-setup --engine chrome --yes` | 直接使用用户日常 Chrome 的登录状态；需要已安装 Claude 浏览器扩展 |

命令会修改 `bridge.json` 里的参数（加 `--mcp-config` 或 `--chrome`，并在 `--allowedTools` 中放行对应工具），然后跑一次连接测试，失败则保持原配置。

注意：重新运行 `bridge-test` 会重置参数，需要再运行一次 `browser-setup`。

## 常见问题

- **报错 "cannot be launched inside another Claude Code session"**：工作台会自动去掉 `CLAUDECODE` 环境变量；如仍出现，请升级 Claude Code。
- **报错未登录**：请用户在终端运行一次 `claude` 完成登录。

## 从旧版本升级

M1 版本生成的 `bridge.json` 没有 `--allowedTools WebSearch,WebFetch`。重新运行一次 `bridge-test --prefer claude-code` 即可更新。
