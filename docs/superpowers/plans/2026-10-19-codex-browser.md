# Codex 浏览器接入

用户授权：复用 Chrome 与 browser-profiles/default，验证小红书只读采集，登录/验证码停下，不发布、不清理资料。

1. Codex 使用进程级 MCP command/args 覆盖，复用现有 mcpConfigFor 路径；不修改用户全局 Codex 配置。
2. applyBrowser 与 browser-setup 支持 Codex Playwright，拒绝 Claude Chrome 扩展模式。后台 worker 兼容判断接受 Codex 传输。
3. 先增加隔离测试验证配置与原资料不变，再运行回归。确认队列空闲后应用配置。
4. 经 Codex MCP 实际打开小红书，只读检查身份及小互资料。遇登录/验证码即停止并保留窗口；如实记录真实验证结果。
