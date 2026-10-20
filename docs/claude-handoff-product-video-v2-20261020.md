# Claude 交接任务：粉剂产品还原第二版 + APIMart 提交异常排查

## 用户目标与授权

继续优化现有小红书运营工作台的产品视频还原。用户要求：用同一段腐乳参考视频和现有粉剂图，先调用已配置的生图 API 制作高保真产品图，再以新产品图生成第二版视频，重点解决品牌文字变形、瓶盖不稳定。保留原素材及第一版结果，不发布。

用户已经授权真实调用 API 进行这次测试。不要重新泛泛询问是否实施。用户只有 API 密钥，没有 APIMart 网页登录密码，不要再要求用户登录控制台、寻找任务编号或提供密码。密钥已在本机配置，禁止输出或写入交接文档、日志、Git。

用户最近明确要求把任务交给 Claude，当前 Codex 已停止继续生成。此文档是交接材料，不代表已创建或启动另一个 Agent。

## 环境和约束

- 项目：`/Users/lizhishaoniange/Documents/小红书自动化运营系统`
- 工作台：`http://127.0.0.1:17890/`
- 数据：`/Users/lizhishaoniange/XHS-Workbench`
- 当前账号：`default`（测试账号）
- shell：zsh；系统 macOS；ffmpeg/ffprobe 位于 `/opt/homebrew/bin/`
- 生图密钥：`/Users/lizhishaoniange/XHS-Workbench/.secrets/image-service.json`
- 视频配置：`/Users/lizhishaoniange/XHS-Workbench/.secrets/video-service.json`
- 不清除 Chrome 登录资料，不解除小红书访问锁，不访问小红书，不自动发布或发送消息。
- 仓库有大量已有未提交修改和新文件。不可 reset/clean/stash 覆盖已有工作；本任务不要求提交或推送。
- 现有后台任务可能变化，重启前检查 `/api/bridge` 的 running/pending 及视频任务；不要中断用户任务。

## 可直接复用的本地调用工具

`/tmp/xhs-image-api.mjs` 导出 `api(method,path,data)`，读取工作台本地 token，默认附加 `account=default`。不要输出其请求头。

```js
import {api} from '/tmp/xhs-image-api.mjs';
const jobs = await api('GET','/api/images/jobs');
```

具体路由请以 `xhs-workbench/server/server.mjs` 为准。不要盲目重发生成 POST；刷新已知任务只查询/取回。

`/tmp/xhs-topic-restart.mjs` 是已有重启辅助：检查 bridge 无在途任务后关闭当前 PID 并启动服务。运行前应审阅，另核对视频提交是否仍在途。

## 原始素材（全部保留）

参考视频：
`/Users/lizhishaoniange/Desktop/有没有和我一样喝粥就馋腐乳的_有没有和我一样喝粥就馋腐乳的_米酱香气超浓豆腐乳软糯不齁咸_拌米饭夹馒.mp4`

720×1280，17.3 秒，4,108,473 字节，带音轨。SHA256：
`5f3075020a0c82bece15de231f223b396c5028ab4bb7ea705ce704fa851f76b6`

工作台原参考视频 ID：
`vref_5f3075020a0c82bece15de231f223b396c5028ab4bb7ea705ce704fa851f76b6`

现有粉剂海报参考图：
`/Users/lizhishaoniange/XHS-Workbench/accounts/default/image-jobs/references/ref_mveoo2e1c89cc6.png`

视频来源 ID：`ref:ref_mveoo2e1c89cc6.png`
生图引用：`{file:'ref_mveoo2e1c89cc6.png', role:'product', source:'studio'}`
SHA256：`a92beac2cc0ded29fd3e1be850e43381530b3090159949e4d1264696ba65d1b3`

这是一张有大幅中文标题的海报，不是产品白底图。左侧前景是姜黄粉罐，后侧另有肉桂粉罐，右下是黄金奶陶杯。包装为棕色玻璃罐、黑色旋盖、米白标签。目标姜黄粉文字应是：
- 品牌：`LUCKBULU`
- 产品：`INDIAN TURMERIC POWDER`

必须先查看原图确认，不能拿第一版视频错误的 `KUCK BULU` 等拼写作品牌依据。不承诺生成模型能逐帧精确保字。

## 第一版真实测试已经完成

工作台描述任务：`vdesc_mvg0agdj20fc4b`
工作台视频任务：`videojob_mvg0eb8cfc4c4e`
远端视频任务：`9841e1c84d50`
模式 rv2v，480×864，124 帧，24fps，成片 5.167 秒，H264 + AAC。

成片路径：
`/Users/lizhishaoniange/XHS-Workbench/accounts/default/video-jobs/videojob_mvg0eb8cfc4c4e/result.mp4`

用户下载副本：
`/Users/lizhishaoniange/Desktop/粉剂rv2v测试-20261020/粉剂参考视频复刻.mp4`

同目录有 `验证记录.json` 和 `动作描述与参考观察.json`。

真实验证过：
1. 工作台导入原参考视频。
2. 实际 Codex CLI 查看12个时间点抽帧，生成描述。
3. 页面应用描述，选择粉剂图，提交 rv2v。
4. 服务返回远端 ID，后台自动查询并下载；生成约耗时8分钟，进度较长时间停留5%，不能仅凭5%断言卡死。
5. 浏览器静音播放到结尾；实际点击下载并校验与工作台文件 SHA256 一致。
6. 核对原视频和粉剂图未变。

画面效果：确实换成手持棕色粉剂罐和金黄色饮品，未见腐乳和原字幕；但品牌文字明显变形、瓶盖形态随帧变化。流程通过，产品还原质量未通过。音轨存在但没有听检，不能声称音频验收通过。

联系图：`/tmp/rv2v-result-contact.jpg`（成片每秒画面）；`/tmp/rv2v-reference-contact.jpg`（原片概览）。

## 第二版已经准备的工作

为了减少开盖动作干扰，从原片约 8.35–9.95 秒的“闭盖手持展示”区间提取副本，放慢到5.166667秒。没有修改原视频。该副本不含音频。

路径：
`/Users/lizhishaoniange/Desktop/粉剂rv2v测试-20261020/第二版/参考片段-仅闭盖展示.mp4`

已上传工作台，ID：
`vref_0d9266986043ef5d0798b0c9e0454b92a6c643c7a0a4462e6c7d21bf4b0545b2`

已经查看 `/tmp/rv2v-v2-reference-check.jpg`，整个区间都是闭盖展示。原片约10秒后出现真实开盖，第一版使用完整原片，这可能增加瓶盖变化的干扰，但不是已经证明的唯一原因。

第二版产品图拟采用：
- 单个姜黄粉罐，去掉肉桂粉罐和海报大标题；
- 标签正对相机，完整清晰的上述两行英文；
- 黑色不透明盖完全闭合，盖沿与瓶口贴合，没有双盖或金色边；
- 手从下方支持，手指不遮标签；陶杯位于侧后；暖木桌和柔光；
- 产品图先检查，文字或瓶盖不合格就不送进视频。

已经发出一次真实 APIMart 生图请求，但没有取得任务 ID，当前状态需要排查，不能算已完成产品图。

## 当前阻塞（必须如实对待）

生图本地任务：`imagejob_mvg0xypl020f1d`
本地记录：
`/Users/lizhishaoniange/XHS-Workbench/accounts/default/image-jobs/imagejob_mvg0xypl020f1d.json`

完整输入及提示词：
`/Users/lizhishaoniange/XHS-Workbench/accounts/default/image-jobs/imagejob_mvg0xypl020f1d/input.json`

provider apimart，model gpt-image-2，size 9:16，resolution 2k，count1，outputMode poster，headline 空。使用现有海报作为 product 引用。选择 poster + 空标题，是因为 background 模式会附加“无字底图”的提示，与保留包装文字冲突；提示词明确要求干净摄影产品图、不要海报大字。

请求创建时间 2026-10-20 01:48:25 UTC（北京时间09:48）。状态 `needs_review`，无 taskId，assets=[]。

已确认：
- 参考图快照 5,088,822 字节，哈希正确，提示词长度1565字符，符合本地参数上限。
- `POST /api/images/service/test` 实测连接、密钥鉴权通过（GET /v1/models HTTP200），这不能证明生成请求被接收、模型权限或余额正常。
- 尝试只读 `GET https://api.apimart.ai/v1/tasks` 返回404，不能据此假定支持列表。
- 官方文档索引目前列出的任务接口是 `GET /v1/tasks/{id}`，没有列出最新任务列表接口；不能以此断言服务内部绝无列表接口。
- 打开官方网页 https://apimart.ai 后进入未登录页面，显示安全验证加载失败；用户明确只有API key，没有网页密码。不要绕过验证或继续让用户登录。
- 没有重发第二次生图请求，没有提交第二版视频，没有修复/虚构远端ID。

关键代码缺陷：
1. `image-service.mjs::request()` 丢弃 fetch 原始网络错误及上游响应内容，只抛通用错误。
2. `image-workflow.mjs::start()` catch 不接收 e，统一改成“提交结果不确定”。HTTP明确拒绝与网络断连被混为一谈。
3. `refreshRemote()` 遇到无 taskId，又把之前错误覆盖成“没有可恢复的远端任务编号”。

因此这次原始提交失败原因未保存，不能诚实地声称已确定是网关、余额、限流、参数或网络问题；也不能断言未扣费。需要尽可能用API key可用的官方查询/诊断能力恢复，再决定后续动作。用户要求自己排查，不要把“去找任务ID”的工作直接甩给用户。

## 建议下一步

1. 阅读输入快照、服务调用与官方文档，检查是否有适用于API key的请求日志、任务查询、余额等已支持接口。只读检查，不猜测私有身份、不过登录验证。
2. 修复诊断记录：保存安全的 HTTP status / request ID /网络错误码/阶段与时间；保留最初错误，禁止记录Key或完整敏感响应。明确拒绝和提交状态不确定要区分；未知结果不要自动重发。
3. 补回归测试：4xx明确拒绝、不确定断连、缺少ID、刷新不覆盖诊断、已知ID恢复下载、密钥不泄露。
4. 恢复原图任务或在有依据的情况下继续生成产品图；保留前一失败记录及来源。不能用假图、任意任务ID来填补流程。
5. 查看产品图，逐字核对 LUCKBULU / INDIAN TURMERIC POWDER 和盖口结构，再提交第二版视频。
6. 第一优先 rv2v + 闭盖片段 + 新产品图，减少手腕旋转和透视变化；必要时评估首帧 i2v 的产品保持能力，但要如实说明模式改变，不把它冒充 rv2v。
7. 生成后取回、下载、浏览器完整预览、逐帧核对；报告改进和仍有的问题，不宣称100%还原。如果纯生成无法稳定保字，需要受控合成/追踪贴标等方案，不能仅凭提示词保证。
8. 新产物放第二版目录，工作台保存独立新任务，不覆盖第一版。

## 关键文件

- `xhs-workbench/server/image-service.mjs`：APIMart配置、调用、任务查询和下载
- `xhs-workbench/server/image-workflow.mjs`：参考图快照、任务状态、落盘
- `xhs-workbench/server/video-service.mjs`：H3认证、预检、提交/查询/下载
- `xhs-workbench/server/video-browser-transport.mjs`：独立浏览器兼容传输，生成前选择连接方式，不重复POST
- `xhs-workbench/server/video-workflow.mjs`：视频快照、去重、远端ID与结果落盘
- `xhs-workbench/server/video-references.mjs`：视频上传、校验、抽帧
- `xhs-workbench/server/video-description-workflow.mjs`：Agent描述任务、结果校验
- `xhs-workbench/server/video-retrieval.mjs`：后台查询/下载
- `xhs-workbench/server/bridge.mjs`：submitLocalDescription，不挂载账号平台浏览器；不要解除访问锁
- `xhs-workbench/web/modules/video-creation.js`：视频页面、参考选择、候选描述应用与恢复
- `docs/superpowers/plans/2026-10-20-reference-video.md`：参考视频功能记录

已配置视频地址是 https://aitoken.homes:9443/api/v1 ，使用 X-API-Key。以本地配置为准，不使用旧IP地址。API文档原件：
`/Users/lizhishaoniange/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_ul5ul7wtnltn22_581e/temp/drag/API(2).md`

APIMart： https://api.apimart.ai/v1/images/generations ，Bearer认证，异步 task_id。
官方索引：https://docs.apimart.ai/llms.txt
模型文档：https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation.md
任务文档：https://docs.apimart.ai/en/api-reference/tasks/status.md

## 测试与交接时状态

参考视频相关此前58项测试通过，真实第一版 rv2v 完成。注意这些测试没有覆盖“没收到生图任务ID之后如何找回最新记录”，不能声称整个容错已验证。

本次为诊断写过两条新失败测试，但尚未实施修复。收到用户要求交接后，已只撤回这两条临时测试，未改生产代码。交接前再次运行：
`node --test tests/apimart-service.test.mjs tests/apimart-workflow.test.mjs`
结果10项通过。不要把这10项通过解释为当前提交异常已解决。

辅助文件（临时目录可能失效，以工作台持久记录为准）：
- `/tmp/rv2v-v2-state.json`：第二版imageId/sourceVideoId
- `/tmp/rv2v-v2-image.mjs`：首次生图脚本，含完整提示词；不要直接重跑（会再次请求start）
- `/tmp/rv2v-v2-watchimage.mjs`：上传片段/刷新脚本，先读代码再使用
- `/tmp/rv2v-user-test-state.json`：第一版ID
- `/tmp/apimart-index.txt`：官方文档索引副本

用户当前最关心的是结果质量和能自己解决问题的工程可靠性，不是继续解释“需要他去控制台查”。请先核对事实，推进可做的排查；确实受外部限制时说清具体边界和已尝试的方法。
