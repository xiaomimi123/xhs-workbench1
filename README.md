# 小红书自动化运营系统

一个可分发的 **Agent 技能包**：装进任意本地 agent（Claude Code、Codex、WorkBuddy 等），说一句"打开小红书工作台"，agent 会在本地启动一个 Web 工作台。用户在网页里和 agent 对话，完成小红书运营工作。

- 面向不懂技术的运营人员：环境安装、服务启动、连接测试都由 agent 完成
- 数据全部存在本地（Markdown + JSON），agent 和工作台读写同一份数据

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 技能包骨架、安装自检、Agent 桥接层、对话面板、知识库、多账号 | ✅ 已完成 |
| M2 | 竞品对标拆解、选题热点、文案、封面配图 | ✅ 已完成 |
| M3 | 定时发布、评论私信、数据复盘 | ✅ 已完成（已在测试账号上验证抓数据、抓评论、回复评论、定时自动发布） |
| v0.4 | 多账号分别登录、实况图与多图编辑、开机自启与防休眠、备份与回收站、知识库智能检索、自动化测试 | ✅ 已完成 |
| v0.5 | 视频笔记、对标追踪（爆款雷达）、历史笔记导入、新手引导 | ✅ 已完成 |
| v0.6 | 知识库管家（自动整理）、视频脚本生产、可选无头模式、对标任务检查点 | ✅ 已完成 |
| v0.7 | 跨平台可用与升级、接入企业中枢（中枢 MCP、能力预检、成果上报、与中枢技能叠加）、CodeBuddy CLI 适配、两档浏览器权限 | ✅ 已完成（当前 v0.7.4，详见 `xhs-workbench/CHANGELOG.md`） |

## 目录结构

```
.
├── README.md
├── package.json               开发脚本（npm test / npm run package，无依赖）
├── tests/                     自动化测试（node:test，含假 agent）
├── tools/package.mjs          打包脚本（先跑测试，再生成 dist/xhs-workbench-v<版本>.zip）
├── docs/
│   ├── architecture.md        整体架构设计
│   ├── m2-content-production.md  M2 内容生产模块设计
│   ├── m3-operations.md       M3 运营自动化设计
│   ├── v0.4-enhancements.md   v0.4 增强功能设计
│   ├── v0.5-enhancements.md   v0.5 增强功能设计
│   ├── benchmark-recovery.md  对标超时检查点与恢复
│   ├── background-browser.md   可选有头只读采集与模型路由
│   ├── benchmark-observation.md 对标卡片与主页/笔记观察
│   └── hub-integration.md      接入企业中枢：发布清单、环境变量契约、与中枢技能的分工
└── xhs-workbench/             ← 分发的技能包（整个文件夹交给用户）
    ├── SKILL.md               agent 入口：安装、自检、启动、值守流程
    ├── README.md              给用户的安装与使用指南
    ├── CHANGELOG.md           更新日志
    ├── adapters/              各 agent 的适配说明
    ├── playbooks/             各模块操作手册（agent 读）
    ├── server/                本地服务（零依赖 Node）
    ├── web/                   工作台前端（纯静态，无需构建）
    ├── scripts/workbench.mjs  统一命令入口
    └── templates/knowledge/   知识库初始模板
```

## 给用户的使用方式

把打包好的 `xhs-workbench-v<版本>.zip` 发给用户，安装与使用说明见 [xhs-workbench/README.md](xhs-workbench/README.md)（随包分发）。简要步骤：

1. 解压，把 `xhs-workbench/` 放进 agent 的 skills 目录（如 Claude Code 的 `~/.claude/skills/`），或放在任意位置。
2. 对 agent 说：**打开小红书工作台**（不支持 skill 的 agent：说"阅读 xhs-workbench/SKILL.md 并照做"）。
3. agent 会自动检查 Node.js、初始化数据、测试连接并在浏览器中打开工作台。

## 测试

```bash
npm test
```

测试自身零依赖（Node 内置 `node:test`）；包含 HTTP 与模拟浏览器的集成测试，覆盖对标卡片的主页/笔记观察、头像文件校验及 agent 增量检查点等场景；实际用例数量以运行结果为准。假 agent 不调用真实 AI，也不读取本机登录资料。

## 打包发布

```bash
node tools/package.mjs
```

- 版本号取自 `xhs-workbench/server/server.mjs` 的 `VERSION`，发布前同步更新 `xhs-workbench/CHANGELOG.md`。
- 包从 git 已提交的内容生成（`git archive`），`xhs-workbench/` 有未提交修改时会拒绝打包；脚本会先做语法检查，最后输出文件数和 SHA-256。
- 包内文件名必须是 ASCII（部分解压工具会把中文文件名弄乱）。知识库模板的中文路径写在 `templates/knowledge/manifest.json` 里，初始化数据目录时再映射成中文。
- 产物在 `dist/`（已加入 `.gitignore`）。

## 开发与调试

需要 Node.js ≥ 18；基础服务无第三方依赖。可选后台有头只读采集需另行安装固定版本 `playwright-core@1.64.1` 到本机数据目录，默认不开启。竞品对标的头像卡片与最多 5 篇主页可见笔记见 [docs/benchmark-observation.md](docs/benchmark-observation.md)；启用的工作进程见 [docs/background-browser.md](docs/background-browser.md)。自动发布/评论、多账号与爆款雷达继续由原流程承担。

```bash
node xhs-workbench/scripts/workbench.mjs setup
```

```bash
node xhs-workbench/scripts/workbench.mjs bridge-test --agent claude-code
```

```bash
node xhs-workbench/scripts/workbench.mjs start --open
```

全部命令：`setup`、`bridge-test`、`browser-setup`、`browser-worker-setup`、`browser-worker-status`、`start`、`open`、`status`、`stop`、`autostart`、`backup`、`restore`、`kb-search`、`lint`、`inbox-next`、`inbox-reply`（不带参数运行可查看说明）。

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `XHS_WORKSPACE` | 数据目录 | `~/XHS-Workbench` |

开发测试时建议把 `XHS_WORKSPACE` 指向临时目录，避免污染真实数据。

## 主要功能

### M1 基础

- **Agent 桥接**：CLI 模式（工作台直接调用 `claude -p`、`codex exec` 等）+ 收件箱模式（agent 在会话中轮询领取任务），首次使用由 agent 自动探测、测试并选择
- **对话面板**：流式显示回复与工具调用，可停止任务，历史对话持久化；Claude Code 支持续接上下文
- **知识库**：目录树、全文搜索、Markdown 预览与编辑、删除进回收站；agent 改动文件后网页实时刷新
- **多账号**：账号定位、人群、风格等信息随每条消息交给 agent；每个账号有独立数据目录
- **安全**：只监听 127.0.0.1，接口需要访问令牌并校验 Host，防止其他网站调用本地 agent

### M2 内容生产（详见 [docs/m2-content-production.md](docs/m2-content-production.md)）

- **竞品对标**：登记对标账号、上传截图；可选后台有头只读核实主页字段（明确字段零模型调用），agent 拆解报告和笔记数据，一键生成选题或沉淀知识库。见 [后台浏览器设计](docs/background-browser.md)
- **选题热点**：agent 按热度 / 契合度 / 竞争空间 / 易产出打分，选题池按状态管理，一键「写成笔记」
- **文案**：笔记编辑器，实时字数与违禁词检查，手机预览，让 agent 写稿 / 改写 / 出标题备选
- **封面配图**：4 个 Canvas 模板 × 6 套配色；新增当前 Agent 交接式文字生图/参考图生成、候选图片校验与套用，底图和标题分开编辑。网页不直接调用聊天中的生图工具，需具备生图能力的 Agent 执行交接任务。

### M3 运营自动化（详见 [docs/m3-operations.md](docs/m3-operations.md)）

- **发布排期**：7 天日历 + 排期列表；到点提醒并提供「手动发布助手」，或交给 agent 自动发布；服务端强制每日上限、发布间隔，错过时间不补发
- **评论私信**：agent 抓取并起草回复，用户逐条确认后再发送（可改为自动发送），草稿实时违禁词检查
- **数据复盘**：指标卡、趋势图、笔记排行（互动率 + 迷你趋势），agent 写复盘报告并沉淀到知识库；支持上传创作者中心导出的表格 / 截图
- **定时调度**：本地服务内置调度器，定时发布 / 定时检查评论 / 每日抓数据，统一发到「⏰ 自动任务」会话；顶栏🔔汇总待处理事项，支持浏览器系统通知
- **浏览器控制**：`browser-setup` 为 CLI 模式的 Claude Code 接入 Playwright MCP 或 Claude in Chrome（需用户同意）；`browser-worker-setup --yes` 可另行安装有头只读组件，同账号 MCP 任务前先释放持久资料。发布/评论仍走原 agent 流程

> 定时任务需要电脑开机且工作台保持运行。

### v0.4 增强（详见 [docs/v0.4-enhancements.md](docs/v0.4-enhancements.md)）

- **多账号分别登录**：每个账号独立的浏览器资料，同账号任务排队，操作前核对小红书号
- **实况图与多图编辑**：配图排序、裁剪、照片/视频文件配对、素材打包下载；文件配对不等于完成 Live Photo 编码，手机相册识别及小红书实况导入尚需专项验证。
- **开机自启与防休眠**：macOS / Windows / Linux；单实例锁防止重复发布
- **备份与回收站**：每日自动备份、一键恢复；删除内容可还原；数据导出 CSV
- **知识库智能检索**：BM25 相关度排序 + 「问 agent」
- **自动化测试**：`npm test`，打包前自动运行

### v0.5 增强（详见 [docs/v0.5-enhancements.md](docs/v0.5-enhancements.md)）

- **视频笔记**：上传视频（mp4 / mov，最大 1GB，流式上传带进度）、封面三选（上传图片 / 截取当前帧 / 模板封面）、图文与视频一键切换互不丢数据、素材打包含视频
- **对标追踪（爆款雷达）**：对标账号开启追踪后定时检查新笔记，超过点赞阈值顶栏提醒，点开详情即已读
- **历史笔记导入**：agent 批量抓取已发布笔记入库，数据复盘立刻有历史数据
- **新手引导**：首开自动弹出的检查清单，自动检测完成状态，可跳过、可重看
- **自动化测试**：42 个

### v0.6 增强

- **知识库管家**：agent 按频率自动整理知识库（归档、合并、索引），让沉淀可持续复用
- **视频脚本**：分镜表 + 口播 + 素材清单，agent 按选题和知识库生成，素材打包随身带走
- **无头抓取**：可选后台模式；小红书抓取默认使用有头浏览器，不能保证规避风控
- **对标超时检查点与头像卡片**：候选、已核实主页和逐篇原始观察增量落盘；列表展示真实头像或占位，详情默认显示主页字段与最多 5 篇可见笔记，报告仍独立；详见 [docs/benchmark-recovery.md](docs/benchmark-recovery.md) 和 [docs/benchmark-observation.md](docs/benchmark-observation.md)
- **自动化测试**：对标检查点、只读 worker、模拟浏览器与 HTTP/SSE 链路等

### 对标资料自动接续（P0）

推荐候选/核实检查点会自动进入当前账号的持久采集队列。agent 已在浏览器采集时就地写主页与逐篇笔记检查点，服务等待任务结束后判断缺项，完整目标不会再开 worker。worker 未开启时接续 agent 浏览器；能力缺失、登录/风控或部分失败会暂停并显示原因。列表支持账号级补齐、暂停、整体继续，无需逐卡点击。身份核实与资料采集状态分开。

实现与隔离验证见 [自动采集说明](docs/benchmark-auto-collection.md)。真实创作者登录与目标主页资料已部分验证；头像、笔记全流程及 Windows Edge 焦点行为尚未通过真实验收，详见自动采集说明。
