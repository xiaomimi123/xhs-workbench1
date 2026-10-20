# iPhone Receiver Implementation Plan

**Goal:** 局域网安全接收已完成Live Photo，并由轻量iOS端保存相册。
**Architecture:** 独立临时传输服务与管理API，工作台展示本地二维码；iOS SwiftUI客户端下载校验、预览、相册配对保存、回执。管理端保留loopback。
**Tech Stack:** Node HTTP/crypto、SwiftUI/AVFoundation/Photos/CryptoKit、Xcode。

- [x] 接收端工程及协议单元测试，模拟器构建，原生保存与重复保存保护。
- [x] 会话服务先写失败测试，完成TTL、撤销、文件校验、回执、隔离监听和管理API。
- [x] 本地二维码及工作台接收界面，超时/失败/安装指引，浏览器验收。
- [x] 独立代码审查和全量测试，粉剂真实素材模拟器端到端；签名安装条件检查。
- [ ] 真机安装、授权、扫码保存实况验收；保留原图，不发布。缺用户操作时如实保持待验收。
