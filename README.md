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

## 目录结构

```
.
├── README.md
├── tools/package.mjs          打包脚本（生成 dist/xhs-workbench-v<版本>.zip）
├── docs/
│   ├── architecture.md        整体架构设计
│   ├── m2-content-production.md  M2 内容生产模块设计
│   └── m3-operations.md       M3 运营自动化设计
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

## 打包发布

```bash
node tools/package.mjs
```

- 版本号取自 `xhs-workbench/server/server.mjs` 的 `VERSION`，发布前同步更新 `xhs-workbench/CHANGELOG.md`。
- 包从 git 已提交的内容生成（`git archive`），`xhs-workbench/` 有未提交修改时会拒绝打包；脚本会先做语法检查，最后输出文件数和 SHA-256。
- 产物在 `dist/`（已加入 `.gitignore`）。

## 开发与调试

需要 Node.js ≥ 18，无第三方依赖。

```bash
node xhs-workbench/scripts/workbench.mjs setup
```

```bash
node xhs-workbench/scripts/workbench.mjs bridge-test --prefer claude-code
```

```bash
node xhs-workbench/scripts/workbench.mjs start --open
```

全部命令：`setup`、`bridge-test`、`browser-setup`、`start`、`open`、`status`、`stop`、`lint`、`inbox-next`、`inbox-reply`（不带参数运行可查看说明）。

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

- **竞品对标**：登记对标账号、上传截图，agent 拆解出报告和笔记数据，一键生成选题或沉淀到知识库
- **选题热点**：agent 按热度 / 契合度 / 竞争空间 / 易产出打分，选题池按状态管理，一键「写成笔记」
- **文案**：笔记编辑器，实时字数与违禁词检查，手机预览，让 agent 写稿 / 改写 / 出标题备选
- **封面配图**：4 个 Canvas 模板 × 6 套配色实时预览；agent 写封面规格后工作台自动渲染成 PNG

### M3 运营自动化（详见 [docs/m3-operations.md](docs/m3-operations.md)）

- **发布排期**：7 天日历 + 排期列表；到点提醒并提供「手动发布助手」，或交给 agent 自动发布；服务端强制每日上限、发布间隔，错过时间不补发
- **评论私信**：agent 抓取并起草回复，用户逐条确认后再发送（可改为自动发送），草稿实时违禁词检查
- **数据复盘**：指标卡、趋势图、笔记排行（互动率 + 迷你趋势），agent 写复盘报告并沉淀到知识库；支持上传创作者中心导出的表格 / 截图
- **定时调度**：本地服务内置调度器，定时发布 / 定时检查评论 / 每日抓数据，统一发到「⏰ 自动任务」会话；顶栏🔔汇总待处理事项，支持浏览器系统通知
- **浏览器控制**：`browser-setup` 为 CLI 模式的 Claude Code 接入 Playwright MCP 或 Claude in Chrome（需用户同意）

> 定时任务需要电脑开机且工作台保持运行。
