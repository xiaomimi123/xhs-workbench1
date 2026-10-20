# 图片创作 Implementation Plan

**Goal:** 独立图片创作、参考复刻与文案配图，共享候选与应用流程。
**Architecture:** 扩展ImageWorkflow支持可选noteId、独立reference库、海报/底图输出；新增图片创作模块作为cover路由入口，保留原cover编辑器供排版使用。
**Tech Stack:** Node.js、原生JS、node:test、内置imagegen。

- [x] tests/image-workflow.test.mjs 添加无笔记创建/完成/绑定多笔记、标题和角色冻结、完整海报封面保留旧文件、共享素材库去重、非法目标和候选篡改测试，先验证失败。
- [x] server/image-workflow.mjs 实现references/uploadReference、start可选noteId/outputMode/headline/style、apply指定target noteId/purpose、saveToLibrary；server.mjs接入references和library路由。
- [x] web/modules/image-creation.js 作为cover导航模块，三个入口及模板排版入口；web/image-workspace.js 管理独立表单、参考角色、候选预览与下载/配图/封面/素材库动作；原cover模块保留并接受底图参数。
- [x] 文案页入口改生成图片，自动传当前笔记；添加UI账号/笔记切换、异步输入与应用行为回归测试。
- [x] 全量测试、独立审查、真实粉剂海报生成及浏览器检查。只用新演示笔记验证关联，原有笔记和素材不变，不发布。
