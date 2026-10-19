# 数据复盘 Implementation Plan

**Goal:** 接通历史数据/对标资料→受控复盘→选题→新草稿，保留现有笔记素材。
**Architecture:** 公共指标解析模块处理未知值；analytics-workflow 冻结数据、验证报告和证据、幂等加入选题；沿用 TopicWorkflow 写稿与任务桥，页面独立呈现受控任务。
**Tech Stack:** Node.js、原生 JS、node:test。

## 约束

不发布、不发送、不重抓平台；两类来源分开；不把缺失值当零、不把对标当账号业绩；旧稿素材保持字节不变。现有未提交模块是本任务依赖，在当前工作区继续增量修改，不回退已有工作。

## 任务

- [x] 新增 tests/analytics-workflow.test.mjs：先断言 metric(null)===null、metric('0')===0、缺分子不计算互动率、partial totals 记录覆盖数量；验证无效结果不得入库、账号隔离、重试、重复入池与写稿保留来源。运行失败后实现 web/analytics-metrics.js、server/analytics-workflow.mjs。
- [x] 在 server.mjs 挂接 AnalyticsWorkflow 的 submit/progress/finish/recover；路由 GET analytics/workflow、POST analytics/review、retry、topic。扩展 TopicWorkflow.write 消费冻结 evidence，不重新拼凑不存在的账号来源。测试冻结输入篡改和写稿原稿不变。
- [x] 新建 web/analytics-review.js 并接入 analytics 页：选择来源、查看覆盖数、生成/重试报告、显示观察/假设/实验及引用、一键入池/写稿；修复历史 KPI/趋势/互动率未知数和异步账号保护。浏览器验证页面状态与实际产出。
- [x] 独立代码审查、全量测试；确认无在途任务后重启。记录原小互笔记所有文件 SHA-256；分别用历史账号和小互资料生成真实报告，加入选题并写新稿，核对原稿不变。保存证据和边界说明。
