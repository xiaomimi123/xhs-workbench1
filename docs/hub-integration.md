# 接入「企业智能体中枢」：发布清单与对接契约

工作台通过中枢的**应用分发**子系统（`apps/` + `open_app` + 岗位包 `apps` 字段）交给员工使用。设计文档在中枢仓库：`docs/superpowers/specs/2026-10-19-app-launcher-design.md`。本文只记录**工作台这边**要做什么、承诺什么。

## 1. 发布一个新版本到中枢（管理员）

在工作台仓库（本仓库）：

```bash
node tools/package.mjs      # 先跑全部测试，再生成 dist/xhs-workbench-v<版本>.zip，并打印文件数与 SHA-256
```

当前版本 **v0.7.4**（`xhs-workbench/server/version.mjs`），包约 424 KB、131 个文件，零第三方依赖。

在中枢仓库（`D:\企业agent中枢系统`）：

1. 把 zip 复制成 `apps/xhs-workbench/0.7.4.zip`（文件名 = `app.json` 的 `version` + `.zip`）。
2. 改 `apps/xhs-workbench/app.json` 的 `"version"`；依赖声明 `requires` 见下面的「能力预检」，其余字段不用变：

   ```json
   {
     "id": "xhs-workbench",
     "name": "小红书运营工作台",
     "version": "0.7.4",
     "description": "小红书自动运营：对标采集、内容生产、评论私信审核，底层 agent 接入公司中枢",
     "entry": "xhs-workbench/scripts/workbench.mjs",
     "requires": {"node": ">=18", "agent_cli": "codebuddy", "capabilities": ["browser"]},
     "setup_args": ["setup"],
     "start_args": ["start", "--open"]
   }
   ```
3. 不需要重启中枢（SHA-256 由中枢按文件内容计算）。旧版本的 zip 可以留着，也可以删掉。每次重新上传都要升版本号。
4. 控制台「岗位包 → 小红书运营 → 可打开的应用」勾选“小红书运营工作台”（演示数据里 `rp-xhs-ops` 已经放行）。

## 2. 员工使用

对已接入中枢的 agent 说“打开小红书工作台”。中枢校验岗位包并写审计，本机接入器下载、校验、解压，然后在包目录下依次执行：

```
node xhs-workbench/scripts/workbench.mjs setup
node xhs-workbench/scripts/workbench.mjs start --open
```

## 3. 工作台对中枢的承诺（对接契约）

| 项 | 内容 |
|---|---|
| 启动脚本 | `xhs-workbench/scripts/workbench.mjs`；`setup` 初始化数据目录；`start --open` **幂等**，输出一行 `URL: <地址>`（已在运行时返回同一个地址并输出“工作台已在运行”） |
| 运行要求 | Node.js ≥ 18。缺 Node 时接入器给出安装指引；**ffmpeg 不是必需**（只有参考视频和视频创作需要），缺失不影响启动，`node …/workbench.mjs doctor` 会列出缺什么、怎么装 |
| 数据位置 | `~/XHS-Workbench`（`XHS_WORKSPACE` 可改），在包目录之外：换版本、清理旧版本目录都不影响账号、笔记、登录资料、排期 |
| 升级 | 每次启动时检查数据版本：版本变化先自动备份（`backups/upgrade-*.zip`）再迁移；迁移失败不推进版本、保留备份、网页显示原因；数据来自更新版本（被换成了旧包）时拒绝启动且不改任何数据 |
| 不被打断 | 工作台里有定时发布、定时检查评论，**接入器不要在它运行时强制重启**；有新版本时返回现有地址并提示“关闭后再打开即可升级”（与中枢设计一致）。要手动升级：`workbench.mjs upgrade --package <zip> --yes`（先备份，旧版保留为 `.bak-<版本>` 可回退） |
| 停止 | `workbench.mjs stop`（由员工对 agent 说“关闭小红书工作台”触发） |
| 首次连接 agent | 接入器只跑 `setup` 和 `start --open`，不跑连接自检。工作台打开后，**网页里会直接出现“连接你的 agent”卡片**，列出本机检测到的 agent（含 WorkBuddy 等桌面类），员工点一下就连好，不需要回到 agent 里说命令 |

## 4. 工作台里的 agent 接入中枢（环境变量契约）

中枢接入器启动工作台前：

1. 写 `~/.hub-agent/hub-mcp.json`，内容 `{"mcpServers": {"enterprise-hub": {…}}}`（命令是员工现在用的 MCP 桥，含令牌续期、心跳、技能同步）。
2. 启动工作台时设置环境变量 **`HUB_MCP_SERVERS_FILE=<该文件的绝对路径>`**。

工作台（v0.7.0 起）这样处理：

- 服务启动时读取该文件，把条目并入底层 agent 的 MCP 配置：对话任务里的 **Claude Code** 能使用 `enterprise-hub` 的知识库检索、岗位技能、`generate_image` / `generate_video` 等工具。
- 校验：只保留 `command/args/env` 或 `url/type/headers` 字段并检查类型；服务名只允许 `[\w-]{1,40}`；最多 8 个；文件超过 64KB 或不合法就整体忽略。**不能覆盖工作台自己的 `playwright`**。
- 收紧：本地描述助手（`--strict-mcp-config`）和浏览器专用的只读采集任务**不加**中枢工具。
- 没有该环境变量、文件不存在或内容不合法时，一切照旧，不报错。
- 「连接与设置」页显示“企业中枢：已接入（enterprise-hub）”，不合法时显示原因。
- 目前只对 **Claude Code** 生效。Codex、WorkBuddy（收件箱模式）按各自方式接入，不在这一版范围；WorkBuddy 本身如果已经配置了中枢的 MCP，就在它自己的会话里直接能用中枢工具。

### 与中枢技能的分工（v0.7.4 起）

| | 中枢技能（`read_skill`） | 本包 `playbooks/` |
|---|---|---|
| 管什么 | 业务标准：口吻、选题标准、合规红线、回复原则、复盘指标 | 怎么在工作台里做：文件位置和格式、检查点、受控任务、浏览器与账号安全 |
| 谁维护 | 公司主管 / 老板（中枢控制台） | 工作台开发 |

- 手册开头的「中枢技能」一行声明对应的公司技能；普通对话任务的提示词（`prompt.mjs` 的 `hubGuidance`）要求 agent 先读它。
- 优先级：格式 / 位置 / 检查点 / 浏览器与账号安全 / 不自动发布以手册为准，业务标准以公司技能为准；**直接冲突先停下来说明**；读不到（没接中枢、没权限、失败）就只按手册做，不重试。
- 发现公司技能或知识库有错 / 过时 / 缺步骤，用 `propose_improvement` 提建议（中枢 MCP 工具，人审核后才生效）。
- 受控任务和只读采集任务没有中枢工具，不加这段指引；没接中枢时提示词不变。

### 复盘经验沉淀（v0.7.5 起）

数据复盘后，agent 把有数据依据的经验结论**建议**沉淀到中枢的「复盘总结」知识库：agent 列出候选并询问 → **用户明确确认** → 调用中枢 `propose_improvement`（`kind=new_doc`，`knowledge_base=复盘总结`）→ 主管在中枢「改进建议」页审核入库。账号数据可以写进去；评论私信里其他用户的昵称 / 联系方式、登录凭证、无关隐私不放；自动任务里不提交；没有中枢工具时只存本地知识库。规则写在 `playbooks/analytics.md`，提示词指引见 `prompt.mjs`。

### 成果上报（v0.7.3 起）

接入器启动工作台时设置环境变量 **`HUB_WORK_OUTBOX=<~/.hub-agent/outbox/xhs-workbench.jsonl>`**。工作台在关键产出变化时往该文件**追加一行** JSON：

```json
{"key":"note:default:n_ab12","title":"笔记：秋季护肤","kind":"笔记","status":"待审核","progress":90,"link":"https://…","note":"待发布"}
```

- `key` 必填，同一产出固定不变（中枢按 人 + 应用 + key 幂等，重复上报是更新）；`status` 为 进行中 / 待审核 / 已完成 / 受阻；链接只放 http(s)。
- 目前上报笔记（draft→ready→published）和对标拆解完成（analyzed）；只在状态变化时写。不写正文、提示词、账号资料、本机路径。
- 接入器每 20 秒（MCP 桥运行时）把新行转发给中枢；也可手动 `hub_agent.py flush-outbox`。没有该变量时工作台什么都不做。
- 代码：`server/hub-work.mjs`；钩子在 `content.mjs` 的 `saveNote` / `saveBenchmark`。agent 直接改文件（绕过这两个函数）的路径不会上报。

### 能力预检（v0.7.2 起）

应用在 `app.json` 的 `requires` 里声明依赖（如 `{"node":">=18","agent_cli":"codebuddy","capabilities":["browser"]}`）。接入器打开应用前预检，写 `~/.hub-agent/capabilities/<app_id>.json` 并设置环境变量 **`HUB_CAPABILITIES_FILE`**：

```json
{"schema":1,"app_id":"xhs-workbench","checkedAt":"…","capabilities":{"browser":{"ready":false,"missing":["CodeBuddy CLI"],"fixes":["npm install -g @tencent-ai/codebuddy-code"]},"agent_cli":{…}}}
```

工作台：每次使用时重读；仅当 `capabilities.browser.ready === false` 时拒绝浏览器专用任务（409，写明缺什么与第一条处理方法）；无变量 / 文件不存在 / 不合法时不拦。文件不含任何密钥。

### 应用根目录与应用健康（v0.8.0 起）

中枢接入器（0.5.0 起）把运行环境、应用包、应用数据、健康日志都放在员工电脑的 `~/HubApps` 下，启动工作台时多传四个环境变量：

| 变量 | 工作台怎么用 |
|---|---|
| `HUB_APP_DATA_DIR` | 数据目录（`~/HubApps/data/xhs-workbench`）。`XHS_WORKSPACE` 优先；已有 `~/XHS-Workbench` 时继续用它，不搬数据 |
| `HUB_APP_STATE_DIR` | 访问锁的位置（`~/.hub-agent/state/xhs-workbench`，在应用根目录之外，agent 碰不到）。第一次原样搬旧锁，旧文件改名 `.migrated` |
| `HUB_HEALTH_OUTBOX` | 任务失败、连接测试结果写到这里（一行一条 JSON），接入器转发到中枢「应用健康」 |
| `HUB_DEVICE_ID` | 本机设备号，事件和接入器的归到同一台设备 |

**不是由接入器启动时（v0.8.1 起）**：本机装了中枢接入器（有 `~/.hub-agent/credentials.json`）就自动补上这些变量（`server/hub-env.mjs`）：`HUB_MCP_SERVERS_FILE` 用 `~/.hub-agent/hub-mcp.json`（接入器 0.5.1 起在接入时就写好），成果上报、健康上报、访问锁、设备号用接入器的默认位置。

agent 直接运行 `workbench.mjs` 命令时没有这些变量：数据目录按 `~/HubApps/data/xhs-workbench` 是否存在找到，锁按 `~/.hub-agent/state/xhs-workbench` 是否存在找到，和工作台服务用的是同一处。

### 出图出视频走中枢（v0.8.7 起）

工作台网页里的生图（图片创作、自由海报）和视频创作可以选「公司中枢」：走中枢的 HTTP 接口 `/api/v1/images`、`/api/v1/videos`、`/api/v1/videos/from-image`、`/api/v1/tasks/{id}`（`server/hub-gen.mjs`），用的是中枢「模型」页配置的通道，权限、GPU 额度、审计按员工岗位包，员工电脑上不存密钥。

- 身份：从 `HUB_MCP_SERVERS_FILE` 里找到接入器（`uv run …/hub_agent.py`），运行 `hub_agent.py token`（接入器 0.5.6 起）拿 `{hub, access_token, expires_at}`；快过期先续期，401 时换一次令牌重试。
- 下载：只接受这个中枢的 `/api/files/` 签名链接；图片加 `fmt=png` 让中枢转成 PNG（中枢 0.8.7 对应版本起支持），再走工作台原有的 PNG 校验入库。
- 参考图（v0.8.10 起）：中枢出图通道是第三方 API 时支持，走 `/api/v1/images/with-references`；工作台先查 `/api/v1/capabilities` 决定界面上能不能选参考图。本机 GPU / H3 网关通道不支持。
- 限制：视频只支持文生视频和首帧生视频，其余模式走视频网关。
- 接上中枢时默认用「公司中枢」；员工在设置里保存过的选择优先。APIMart 和视频网关保留，作为备选。

### 采集节奏与额度（v0.8.11 起）

「开始采集」「补齐」「核实主页」和队列自动接续下一个对标目标之前，工作台在**服务端**检查：采集总开关（默认关）→ 冷静期 → 时段（默认 09:00–22:30）→ 每天笔记 / 主页上限（10 / 3）→ 两次采集最小间隔（180 分钟）。不满足返回 409 并说明原因；队列遇到不满足就暂停，要人再点开始，不会在后台等到点自动继续。可调的数在网页「竞品对标」的采集卡片里（有边界）。

- 账本（`pace-ledger.jsonl`）由工作台自己记：派发采集记会话，合并检查点时按检查点文件的写入时间记主页和笔记，链接去掉查询参数。不靠 agent 上报（CodeBuddy 工具里没有 Bash）。
- 读得太快：两篇笔记的检查点相隔不到 20 秒 → 取消正在跑的 agent 任务、暂停队列、自动关总开关。一份检查点里装多篇、补合并的旧检查点不触发。
- 策略（`pace-policy.json`）放在 `HUB_APP_STATE_DIR`（和访问锁一起，agent 碰不到）；没接中枢时放账号数据目录。接口：`GET /api/browse/pace`、`POST /api/browse/policy`（`enable` / `disable` / `set-cooldown` / `clear-cooldown` / `set-limits`）。
- 这些数只是控制读取量，**不保证不触发平台风控**；agent 在一次会话里每一步怎么点，工作台管不到。
- **后台 Playwright 采集和登录核对已停用（v0.8.11 起）**：采集只走员工自己浏览器里的 WorkBuddy 插件。组件的 `verify` / `prepare` 拒绝，相关接口 409，队列只选 agent 路径；`XHS_ALLOW_WORKER_COLLECT=1` 只给开发 / 自动测试放开。图片封面渲染（headless Edge 画本地 HTML）不受影响。
- `XHS_PACE_RELAX=1` 只给开发 / 自动测试：关掉「时段 / 采集间隔 / 读得太快」三项，生产里不要设。

## 5. 已验证与未验证

**已验证（Windows）**

- 解压发布包到空目录，按上面的约定执行 `setup`、`start --open`（两次，幂等），带 `HUB_MCP_SERVERS_FILE` 启动后 `/api/state` 报告 `hub.connected = true`（早期用 0.7.0 验证，之后每个版本都用中枢真实的 `open-app` 打开过）。
- 自动化测试 359 项（含 `hub-mcp`、`hub-capabilities`、`hub-work`、`hub-guidance` 等中枢对接用例）；本机没装 ffmpeg 时参考视频相关的 2 项会失败，与功能无关，打包时用 `--skip-tests`。
- 工作台本身的真实流程：APIMart 生图、视频生成与参考视频换主体、WorkBuddy 值守（重启不丢任务、中文不乱码）。

**未验证**

- 工作台里的 **Claude Code** 真正调用到中枢 MCP 工具（目前真实验证的是 **CodeBuddy CLI 2.171.0**：读中枢技能、调用中枢模型、提交改进建议都已在真实环境跑通）。
- macOS / Safari。实况图、本地二维码、截图 OCR 核对目前只支持 macOS。

## 6. 中枢侧建议的后续工作

1. ~~`skills/运营部/xhs-*` 目前是通用占位内容~~（已完成：七个运营技能已改写成业务标准并发布，与本包的操作手册叠加使用，见上面「与中枢技能的分工」）。
2. 知识库 `vault/历史爆款笔记`、`品牌调性与人设` 与工作台自己的知识库（`~/XHS-Workbench/knowledge`）目前是两套；先分别使用，需要打通时再定同步方向。
3. ~~工作台自己的生图 / 视频密钥改成走中枢~~（v0.8.7 已加「公司中枢」通道，见上面「出图出视频走中枢」；参考图出图、参考主体 / 复刻视频还要中枢先支持）。
