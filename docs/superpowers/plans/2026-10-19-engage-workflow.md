# 评论私信本地审核 Implementation Plan

**Goal:** 历史消息整理→受控回复草稿→编辑→本地确认/撤回，原数据不变且不发送。
**Architecture:** EngageWorkflow 将消息、笔记URL关联和口径冻结成输入；Agent 只写暂存结果，校验后将审核记录保存在独立 reply-jobs。编辑与确认使用版本检查。新审核面板与既有发送队列物理隔离。
**Tech Stack:** Node.js、原生 JS、node:test。

## 约束

不发送、不抓取、不打开私信、不修改原 engage/items.json/笔记/配置。历史已回复、已忽略状态不重新激活。本地确认不是用户逐条审阅的声明，演示结束撤回全部确认，保留新草稿。

- [x] tests/engage-workflow.test.mjs 先验证来源关联、原文件不变、空稿/旧版本/跨账号拒绝、编辑撤销确认、消息变化后阻断确认、结果伪造/重试/重启；实现 server/engage-workflow.mjs。
- [x] server.mjs 接入任务桥和 GET engage/workflow、POST engage/review、retry、edit、confirm、revoke 路由；假 Agent HTTP 测试验证端到端不进入发送队列。
- [x] web/engage-review.js 接入历史消息整理/筛选、选中生成、任务进度、草稿编辑/保存/确认/撤回；旧模块展开区隔离，新增编辑状态按账号保存，切页/刷新/筛选不丢编辑。补页面竞态测试。
- [x] 独立审查、全量测试；无在途任务后重启，用已有评论和私信实际生成草稿，验证编辑、确认、编辑后失效、再确认与最后撤回；校验原文件摘要、保存证据和边界说明。
