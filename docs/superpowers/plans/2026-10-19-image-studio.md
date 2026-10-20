# Image Studio Implementation Plan

**Goal:** 当前 Agent 交接式文生图/参考图生成、候选预览与套用封面。
**Architecture:** 独立 ImageWorkflow 保存冻结参考与生成清单，校验 PNG 后导入候选；前端封面面板通过 REST 保存任务/检查结果/应用图片，复用现有可编辑模板。
**Tech Stack:** Node.js、原生 JavaScript、node:test、内置 imagegen。

- [x] 新建 tests/image-workflow.test.mjs：生成1张有效PNG后完成，应用两次只增加一个素材；参考图冻结；路径穿越/软链接/无图/输入变化/跨账号/文案变化拒绝。先运行得到缺模块失败。
- [x] 实现 server/image-workflow.mjs：start(account,{noteId,prompt,references,count,newRound})、jobs(account,noteId)、complete(account,id)、apply(account,{id,index})；结果清单 {images:[{file:"candidate-1.png"}]}，PNG 必须 >=512像素、<=4096边长；只应用时写入笔记images，记录生成来源。
- [x] server.mjs 增加 GET /api/images/jobs、POST /api/images/start、complete、apply；完整任务通过已认证 API 读取，输出任务交接指令。
- [x] web/image-studio.js 新建独立面板；草稿输入按账号/笔记保留、请求捕获账号和笔记防串写；生成/检查/套用使用明确按钮。cover.js 挂载面板并复用 photo 模板保存流程。
- [ ] 跑隔离测试与全量测试，实际生成底图、参考图变化图，验证候选预览/套用/保存，原稿和旧素材不变。记录真实能力边界与后续Live Photo验证范围。

代码与测试完成，全量142项通过。最后一项真实生图验收未完成：内置工具约15分钟未返回，已结束本轮等待，保留任务，详见 docs/cover-workflow.md。
