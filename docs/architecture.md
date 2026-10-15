# 小红书自动化运营工作台 · 整体架构设计

> 状态：M1–M3、v0.4、v0.5 增强已实现（v0.5.0）。模块设计细节见 [m2-content-production.md](m2-content-production.md)、[m3-operations.md](m3-operations.md)、[v0.4-enhancements.md](v0.4-enhancements.md)、[v0.5-enhancements.md](v0.5-enhancements.md)。

## 1. 目标与定位

- **产品形态**：一个可分发的 Skill 技能包（文件夹）。任何装了 agent 的用户（Claude Code、Codex、WorkBuddy、Cursor、Gemini CLI 等）把它放进自己 agent 的 skills 目录，或直接把文件夹丢给 agent，说一句"打开小红书工作台"即可使用。
- **用户画像**：只会安装现成 agent 的运营人员。Node/Python 环境安装、服务启动、桥接测试**全部由用户本地的 agent 代劳**，用户不碰命令行。
- **交互方式**：浏览器里的 Web 工作台 = 对话框 + 业务面板；真正干活的是本地 agent。

## 2. 总体架构

```
┌────────────────────────── 浏览器 ──────────────────────────┐
│  Web 工作台：对话面板 │ 选题 │ 文案 │ 封面 │ 排期 │ 互动 │ 数据 │ 对标 │ 知识库 │
└───────────────▲───────────────────────────────────────────┘
                │ HTTP + SSE（流式）  127.0.0.1:随机端口
┌───────────────┴──────── 本地服务 server/（零依赖 Node）────────┐
│  · 静态页面托管      · 业务数据读写（数据目录下 JSON + Markdown）    │
│  · 任务队列 & 定时调度  · Agent 桥接层（adapter 二选一，见 §3）     │
└───────────────▲───────────────────────────────────────────┘
                │
┌───────────────┴──────── 用户本地 Agent ──────────────────────┐
│  读取 playbooks/*.md（各模块操作手册）执行具体工作：             │
│  写稿、调用浏览器/电脑控制工具发布、抓数据、拆解对标账号……         │
└──────────────────────────────────────────────────────────┘
```

**关键原则：数据全部是本地文件**（Markdown + JSON），agent 能直接读写，工作台只是它们的可视化界面。即使桥接失效，用户也能直接在 agent 里说"帮我写一篇笔记"，结果同样会出现在工作台。

## 3. Agent 桥接层（核心难点）

不同 agent 能力差异大，所以设计两种适配模式，由**用户的 agent 在首次安装时自行探测、测试并写入配置**（`workspace/config/bridge.json`）。

### 模式 A：CLI 驱动（优先）
本地服务直接以 headless 方式调用 agent 命令行，流式读取输出：

| Agent | 调用方式（示例，由安装时探测确认） |
|---|---|
| Claude Code | `claude -p "<prompt>" --output-format stream-json` |
| Codex | `codex exec "<prompt>"` |
| Gemini CLI | `gemini -p "<prompt>"` |
| 其他 | 安装时由 agent 自己填写命令模板 |

优点：工作台可以随时唤起 agent，支持定时任务在无人值守时执行。

### 模式 B：收件箱轮询（通用兜底）
适用于没有 headless CLI 的 agent（如 WorkBuddy、IDE 类 agent）：
1. 用户在工作台发消息 → 本地服务存进队列。
2. agent 在自己的会话里按 SKILL.md 的指示进入"值守循环"：`GET /api/agent/next`（长轮询）取任务 → 执行 → `POST /api/agent/reply` 回写结果（可分段推送进度）。
3. 工作台通过 SSE 实时显示回复。

只要 agent 能执行 shell 命令（curl），这个模式就能用。缺点是 agent 会话必须开着。

### 安装 & 自检流程（写进 SKILL.md，由 agent 执行）
1. 检查/安装 Node.js（缺失时 agent 引导或代为安装）。
2. 初始化 `workspace/`（数据目录，默认在用户主目录 `~/XHS-Workbench/`）。
3. 探测可用的 agent CLI → 逐个跑一次"回声测试"（发 `ping`，期望返回 `pong`）→ 成功则选模式 A，否则选模式 B。
4. 启动本地服务，打开浏览器；工作台右上角显示桥接状态（绿/黄/红）。
5. 结果写入 `bridge.json`，后续启动直接复用；服务日志在 `logs/server.log`。

### 已实现的细节（M1）
- 统一命令入口 `scripts/workbench.mjs`：`setup / bridge-test / start / open / status / stop / inbox-next / inbox-reply`，SKILL.md 只需教 agent 调这一个脚本。
- 提示词一律优先走标准输入，避免 Windows 等平台的命令行转义问题。
- Claude Code 使用 `stream-json` 输出：工具调用实时显示在网页里；记录 session_id，同一网页对话的后续消息用 `--resume` 续接上下文。其他 agent 每条消息附带最近 10 条对话历史。
- 从 Claude Code 会话里启动时自动去掉 `CLAUDECODE` 环境变量，避免嵌套调用被拒。
- 取消任务时结束 agent 的整个进程组；单次任务默认超时 30 分钟（`bridge.json` 的 `timeoutMs` 可改）。
- 收件箱模式：长轮询领取（默认 110 秒，适配多数 agent 的命令超时）；`inbox-reply` 不带 `--final` 时显示为进度行，带 `--final` 时作为最终回复；agent 在领取过程中断开会自动把任务放回队列。

### 本地安全
- 只监听 `127.0.0.1`，端口 17890–17910 自动选择。
- 所有 `/api/*` 接口要求访问令牌（`run/token`，通过 `?t=` 交给浏览器后存入 localStorage），并且令牌放在自定义请求头里，其他网站的跨站请求无法通过预检；同时校验 Host 头，防 DNS 重绑定。
- 知识库等文件接口限制在数据目录内，防止 `../` 越界。

## 4. 功能模块

每个模块 = 一个工作台面板 + 一份 `playbooks/<模块>.md`（告诉 agent 这件事怎么做、输出存哪、格式是什么）。

| 模块 | 工作台功能 | Agent 做什么 | 数据位置 |
|---|---|---|---|
| 选题/热点 | 热点列表、候选池、打分排序 | 浏览小红书搜索/热榜、结合知识库与账号定位生成选题 | `accounts/<id>/topics/` |
| 文案 | 草稿编辑器、版本对比、违禁词提示 | 按爆款结构写标题/正文/话题标签，自检敏感词 | `accounts/<id>/notes/<笔记id>/note.md` |
| 封面配图 | 模板选择、预览 | 写封面规格（JSON），工作台用 Canvas 模板渲染成 PNG；有生图工具时生成配图 | `accounts/<id>/notes/<笔记id>/images/` |
| 定时发布 | 日历排期、发布队列、发布记录 | 到点后控制本地浏览器打开创作者中心完成发布，截图留证 | `accounts/<id>/schedule.json` |
| 评论私信 | 待回复列表、回复草稿、一键确认 | 抓取新评论/私信，按知识库口径生成回复草稿 | `accounts/<id>/engage/` |
| 数据复盘 | 笔记数据表、趋势图、复盘报告 | 定时抓取笔记数据，生成复盘结论并反哺知识库 | `accounts/<id>/analytics/` |
| 竞品对标 | 对标账号列表、拆解报告 | 抓取对标账号笔记，拆解选题/标题/封面/结构规律 | `accounts/<id>/benchmarks/` |
| 知识库 | 文档树、搜索、标签 | 沉淀：品牌口径、爆款公式、复盘结论、拆解结果 | `knowledge/`（所有账号共享） |

**模块之间的闭环**：对标拆解 → 知识库 → 选题/文案引用知识库 → 发布 → 数据复盘 → 结论回写知识库。

## 5. 电脑控制 / 浏览器自动化策略

- 优先用 agent **自带的**浏览器或电脑控制能力（Claude in Chrome、Computer Use、Codex 的浏览器工具等）；playbook 里只写"要达成什么、怎么判断成功"，不绑死某个工具。
- 兜底：skill 内附一个可选的 Playwright 脚本，由 agent 按需安装，使用**用户自己已登录**的浏览器配置。
- **账号安全**（写死在 playbook 里）：
  - 登录永远由用户本人完成，agent 不接触密码和验证码。
  - 模拟真人节奏：随机间隔、单日发布/回复数量上限可在设置中配置。
  - 评论/私信回复默认"草稿 + 人工确认后发送"，用户可在设置里改为自动发送。
  - 风控提示（验证码、异常弹窗）出现时立即停止并通知用户。

## 6. 技能包目录结构

```
xhs-workbench/                 ← 分发的 skill 包
├── SKILL.md                   ← 入口：安装、自检、启动、值守循环说明（agent 通用）
├── adapters/                  ← 各 agent 的适配说明
│   ├── claude-code.md  codex.md  workbuddy.md  generic.md
├── playbooks/                 ← 各模块操作手册（agent 读）
│   ├── README.md（索引 + 账号安全规则）  knowledge.md
│   ├── benchmark.md  topics.md  copywriting.md  cover.md
│   └── browser.md  publish.md  engage.md  analytics.md
├── server/                    ← 零依赖 Node 本地服务
│   ├── server.mjs   HTTP 接口、SSE 推送、会话管理
│   ├── bridge.mjs   桥接层（CLI 运行器、收件箱队列、连接自检）
│   ├── adapters.mjs 已知 agent CLI 的调用模板
│   ├── prompt.mjs   网页消息 → agent 提示词
│   ├── store.mjs    数据层（账号、知识库、对话、配置）
│   ├── content.mjs  M2 内容数据（对标、选题、笔记、封面）
│   ├── automation.mjs M3 排期、评论私信、数据、自动化设置、提醒与定时调度器
│   ├── browser.mjs  按账号隔离的浏览器配置
│   ├── system.mjs   开机自启、防休眠
│   ├── backup.mjs   备份与恢复
│   ├── search.mjs   知识库检索（BM25）
│   └── zip.mjs      零依赖 ZIP 读写
│   └── paths.mjs    路径定义
├── web/                       ← 工作台前端（纯静态，无需构建）
│   ├── index.html  app.js（导航、对话、知识库、账号、设置）  core.js（公共状态与接口）
│   ├── md.js（离线 Markdown 渲染）  lint.js（字数与违禁词）  covers.js（封面 Canvas 模板）  styles.css
│   └── modules/  benchmark.js  topics.js  copywriting.js  media.js  cover.js  schedule.js  engage.js  analytics.js  system.js  onboarding.js
├── scripts/workbench.mjs      ← 统一命令入口
└── templates/knowledge/       ← 知识库初始模板

~/XHS-Workbench/               ← 运行时用户数据（不随 skill 分发，可用 XHS_WORKSPACE 修改）
├── config/        bridge.json  settings.json  accounts.json
├── accounts/<id>/ benchmarks/ topics/ notes/ engage/ analytics/ schedule.json automation.json
├── browser-profiles/<id>/  每个账号的 Playwright 浏览器资料（启用后）
├── backups/       自动 / 手动备份
├── knowledge/     知识库（所有账号共享）
├── chats/         网页对话记录
├── logs/          运行日志
├── run/           server.json（端口、pid）、token
└── .trash/        回收站（所有删除都移到这里）
```

**技术选型理由**：服务端用零依赖 Node（只用内置模块），前端用纯 HTML/JS 无构建步骤，这样 agent 安装时只需要 Node 一个运行时，出错概率最低。

## 7. 已确认的决策

- 多账号：数据按账号隔离存放，知识库所有账号共享（文档可用 frontmatter 的 `account` 字段标注专属账号）；界面顶栏切换当前账号。
- 数据目录默认 `~/XHS-Workbench/`。
- 开发顺序：
  - **M1** ✅：skill 骨架 + 安装自检 + 桥接层 + 对话面板 + 知识库 + 多账号
  - **M2** ✅：对标拆解 + 选题 + 文案 + 封面
  - **M3** ✅：定时发布 + 评论私信 + 数据复盘
  - **v0.5** ✅：视频笔记 + 对标追踪雷达 + 历史笔记导入 + 新手引导

## 8. 已知限制

- CLI 模式下 agent 无法弹出授权确认：Claude Code 默认只放行改文件和网页搜索 / 读取；自动发布等功能需运行 `browser-setup` 接入浏览器控制（见 `adapters/claude-code.md`）。
- 收件箱模式需要 agent 会话保持打开；空闲轮询会消耗少量 agent 调用。
- Codex、CodeBuddy、Gemini、Qwen、OpenCode 的调用模板来自各自文档，尚未在真机上逐一测试；以 `bridge-test` 的实测结果为准。
