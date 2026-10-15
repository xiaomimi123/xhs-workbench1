# 操作手册索引

做某个模块的事情之前，先读对应手册。

| 模块 | 手册 | 状态 |
|---|---|---|
| 知识库 | [knowledge.md](knowledge.md) | ✅ 可用 |
| 浏览器与账号核对（所有网页操作的前置步骤） | [browser.md](browser.md) | ✅ 可用 |
| 竞品对标 | [benchmark.md](benchmark.md) | ✅ 可用 |
| 选题热点 | [topics.md](topics.md) | ✅ 可用 |
| 文案 | [copywriting.md](copywriting.md) | ✅ 可用 |
| 封面配图 | [cover.md](cover.md) | ✅ 可用 |
| 发布排期 | [publish.md](publish.md) | ✅ 可用 |
| 评论私信 | [engage.md](engage.md) | ✅ 可用 |
| 数据复盘 | [analytics.md](analytics.md) | ✅ 可用 |

手册以外的任务：按用户要求完成，产出物存到「当前账号数据目录」下对应子目录，可沉淀的经验写进知识库。

## 自动任务

提示词以【自动任务 · …】开头的消息来自工作台的定时调度（定时发布、定时检查评论、定时抓数据、对标追踪检查），此时用户可能不在电脑前：
- 按对应手册执行，结果务必写回文件（工作台靠文件判断任务结果）。
- 需要用户介入（登录、验证码、风控提示）时，停止并写明原因，不要等待太久。

## 数据目录结构

```
~/XHS-Workbench/
├── config/            accounts.json（账号）、bridge.json（连接）、settings.json
├── accounts/<账号id>/
│   ├── benchmarks/    对标账号（index.json + 每个账号的 report.md / notes.json / screenshots/）
│   ├── topics/        选题池 topics.json
│   ├── notes/         笔记，每篇一个目录（meta.json + content.md + images/ + cover.png）
│   ├── schedule.json  发布排期
│   ├── engage/        评论私信 items.json
│   ├── analytics/     数据（notes.json、account.json、reports/、imports/）
│   └── automation.json  自动化设置（定时检查、频率限制等，由工作台维护）
├── knowledge/         知识库（所有账号共享，Markdown）
├── chats/             网页对话记录
├── logs/              运行日志
└── .trash/            回收站
```

## JSON 文件写入约定

- 修改 JSON 时先读取原文件，只改需要的字段，保留其他字段，写回合法 JSON。
- 直接用读写文件的工具编辑，不要为此专门写脚本（无界面模式下执行命令可能被禁止）。
- 不要删除条目和文件；用户在界面上删除时会自动移入回收站。

## 账号安全规则（控制浏览器 / 电脑操作小红书时必须遵守）

1. 登录、扫码、验证码、短信验证一律由用户本人完成，你不接触密码。
2. 使用用户自己已登录的浏览器，不新建账号、不批量切换账号。
3. 模拟真人节奏：每个操作之间随机停顿几秒，不要短时间内大量发布、点赞、评论、关注。
4. 评论和私信回复默认先生成草稿给用户确认，用户明确允许后才自动发送。
5. 出现验证码、"操作频繁"、风险提示、异常弹窗时，立即停止并告诉用户。
6. 发布前确认内容不含违禁词、虚假宣传、未授权的他人图片。
