# 文案任务 Implementation Plan

**Goal:** 将选题草稿接入可追踪的改写、标题优化和检查，并以真实小互稿件验证。
**Architecture:** 独立 CopyWorkflow 复用持久文件任务与 Bridge，冻结输入保留原稿，严格验证输出；编辑器显示任务和报告。
**Tech Stack:** Node.js、原生浏览器 JS、node:test。

- [x] 新建 tests/copy-workflow.test.mjs：隔离账号测试改写只更新正文标签、标题仅更新备选、检查只生成报告；验证重复、冲突、过期、错误、重试、恢复。先运行失败，再实现 server/copy-workflow.mjs。
- [x] server/server.mjs 接入 start/retry/jobs 接口和 Bridge 生命周期；web/modules/copywriting.js 接入要求输入、来源、进度、备选理由和报告，保留未保存编辑。
- [x] 运行针对性测试和完整 npm test；检查代码与浏览器。
- [x] 确认没有在途任务后更新服务，用 n_mvc84cl5e37068 顺序完成改写、标题优化、选标题与内容检查，保留原稿快照和证据，不发布。

用户已批准设计和执行，在当前工作区逐项实施，保留所有已有修改，不提交无关文件。
