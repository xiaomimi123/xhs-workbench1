# 封面配图 Implementation Plan

**Goal:** 从既有草稿生成三套封面和三张可编辑卡片，保存实际 PNG 并逐张预览，保护文案与素材。
**Architecture:** 独立 CoverWorkflow 管理冻结输入、agent 方案校验与 PNG 保存；浏览器复用 Canvas 模板。任务区分待渲染与完成，卡片追加且幂等，替换封面备份。封面编辑器和文案预览复用实际素材。
**Tech Stack:** Node.js、原生浏览器 JS、Canvas、node:test。

- [x] tests/cover-workflow.test.mjs 先覆盖来源草稿保护、校验、幂等、过期、恢复、PNG 保存、素材上限与备份；实现 server/cover-workflow.mjs。
- [x] server/server.mjs 接入任务和图片保存接口、Bridge 生命周期；封面页接入任务、卡片编辑、渲染与恢复，保存前后检查编辑版本和账号。
- [x] 文案预览逐张浏览实际封面和配图，保留顺序和原有视频行为；针对性测试后执行全量测试和独立审查。
- [x] 检查在途任务后更新工作台，用小互改写稿验证方案生成→封面保存→三张卡片落盘→逐张预览，检查真实图片并保存证据。文案与既有素材不变、不发布。
