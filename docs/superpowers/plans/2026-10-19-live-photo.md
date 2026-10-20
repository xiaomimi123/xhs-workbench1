# Live Photo Implementation Plan

**Goal:** 图片候选自动制作真实Live Photo，保留原图，明确本地与手机验收。
**Architecture:** 独立live-photo-workflow管理异步任务/快照/校验/导出；原生Swift封装负责Apple元数据与PHLivePhoto加载；图片创作候选提供制作按钮，单独实况页预览下载与人工验收。
**Tech Stack:** Node.js、原生JS、Apple AVFoundation/ImageIO/Photos、CoreImage 轻微运镜。HyperFrames工具在调用时出现版本不可用，未用于最终导出。

- [x] 隔离任务测试先失败，再实现来源冻结、幂等、异步完成/错误/重启恢复、输出完整性与人工验收记录。
- [x] 原生配对工具及真实文件测试：统一UUID、定时元数据、三秒视频、Apple PHLivePhoto识别。输出为新目录。
- [x] HTTP路由和实况UI：候选入口、状态、预览、ZIP、导入指引、人工实测记录；不加入普通图片媒体列表或发布队列。
- [x] 全量测试/独立审查，真实粉剂海报生成，浏览器预览下载，原图哈希不变。
- [x] 用户iPhone照片与小红书编辑预览实测；必要登录交给用户，不发布。
