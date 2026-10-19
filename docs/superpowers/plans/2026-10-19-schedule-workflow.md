# 发布排期 Implementation Plan

**Goal:** 检查实际图文素材，保存不执行发布的排期草案并安全预览。
**Architecture:** 独立 preflight 模块计算稿件与素材指纹，schedule draft API 管理非执行草案；现有调度器显式跳过草案。页面复用图文预览，表单保留编辑状态。
**Tech Stack:** Node.js、原生 JS、node:test。

- [x] 隔离测试检查指纹、缺图、重复、时间、账号隔离、草案禁止转换与到点不执行；实现 server/preflight.mjs 与 automation.mjs 草案接口。
- [x] 发布排期页接入检查/草案/改时间/取消/预览，文案和封面跳转携带笔记。
- [x] 针对性与全量测试、独立审查；真实工作台检查小互笔记，创建并改期、预览四图、取消演示草案。
- [x] 验证原文案素材不变，保存证据；不打开创作者中心、不发布。
