# Codex 浏览器接入与真实验证 · 2026-10-19

已配置工作台 Codex CLI → Playwright MCP @0.0.83 → 原有系统 Chrome。
复用 /Users/lizhishaoniange/XHS-Workbench/browser-profiles/default，未删除/清空/复制登录资料；未修改全局 Codex 配置。进程级 MCP 参数按账号生成。

当前开放 navigation、snapshot、screenshot、wait_for 用于只读采集，未自动授权点击、填表和脚本。设置页标明“只读采集”。支持原后台有头只读 worker；发布能力未启用、未测试。

## 实际验证

通过项目实际 runCli 桥接函数启动 Codex，调用 Playwright MCP，打开小互主页并从可见链接打开一篇笔记；真实页面快照落在工作台 run/browser-output/default 中。

- 小互主页： https://www.xiaohongshu.com/user/profile/5805953450c4b46abdb83956
- 小红书号 xiaohu_ai；可见粉丝1463；简介读取成功。
- 前三条卡片：Opus 5.5确实牛P啊 本视频完全由Claude完成；AI利用扫地机器人即可完成自我复制...；一块画布任由你发挥。
- 读取一篇笔记标题和正文：作者通过 Claude Code 聊天制作 SpaceX 发展历程视频，配音使用豆包，共微调约10次。
- 页面快照没有显示点赞/收藏/评论具体数值，保留为未采集，未记为0。
- 可见“我”链接到具体个人主页、消息数量53，支持登录态仍有效的判断。未遇登录墙、验证码；未验证当前“我”的小红书号是否与配置账号完全一致，未据此修改账号身份。
- 只读访问，不发布、不点赞、不评论、不关注；没有覆盖既有对标记录。

证据：主页 page-2026-10-19T06-04-51-507Z.yml、笔记 page-2026-10-19T06-05-01-379Z.yml（位于本机工作台 run/browser-output/default，含平台签名链接，不提交）。

## 检查

新增隔离测试先失败后通过：Codex参数不混入Claude选项，profile文件保持不变，allowlist不包含点击/脚本/填表。automation + bridge + browser-worker-server：22通过；最终增加allowlist回归后 automation + bridge + server：39通过。独立只读代码审查无阻断问题。

初次真实连接因默认工具需要审批而被CLI never策略拒绝，未访问网页；按本次用户授权将进程工具范围收窄为上述四项后重测，实际页面访问成功。此配置不修改全局审批策略。

确认无排队/运行任务后保存配置并重启，GET /api/bridge 确认 Codex CLI、Playwright、chrome、workerCompatible=true。
