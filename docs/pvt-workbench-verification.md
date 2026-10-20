# PVT 工作台接入验收 · 2026-10-19

## 用户真机反馈

用户明确确认：粉剂 PVT 测试包通过 iPhone「文件」解压、打开并保存到照片后，iPhone 相册和小红书均识别实况并能播放。此为用户反馈，不是 Agent 操作真机；没有发布。

## 正式接入

入口：图片创作 → 实况照片制作记录 → 下载 PVT 实况包 / 生成手机下载码。
无需安装 App 或登录 Xcode。二维码打开普通 Safari 下载说明页；15 分钟到期，可撤销。管理接口保留本机鉴权，局域网会话仅提供素材页面与下载，不暴露管理接口。原生接收端工程仅作历史备用。

PVT：Live-Photo.pvt/ 下包含同名 JPG、MOV、metadata.plist；资源使用既有实况校验结果且原样打包。格式参考 Hronrad/livephoto-forge 的 PVT 布局（41d2366f68dffad7a1be038de7613882b117d077），独立使用项目自身 ZIP 工具实现。

## 验证证据

- 新增 PVT 会话回归测试先失败（返回旧 App scheme）后通过。
- 全量测试 XHS_TEST_NATIVE_LIVE=1 npm test：164 通过，0 失败、0 跳过。
- 最后修改后的 live-photo 和 live-transfer-ui：5 通过。git diff --check 通过。
- 正式粉剂下载 /tmp/xhs-pvt-integrated.zip 由 Python zipfile 独立验证；JPG/MOV 与用户已实测包逐字节一致，plist 内容语义一致。
- 浏览器验证直接下载 HTTP 200、二维码图片正常加载、不再展示 Xcode 要求、撤销后提示“下载码已撤销”；手机下载页显示解压、打开 PVT、保存到照片操作步骤。
- 独立代码审查无阻断问题。修复通用人工确认按钮误写 PVT 来源，用户明确确认本次 PVT 路径的记录则保留 method=pvt。
- 下载状态仅表示服务端提供下载，不冒充 iPhone 相册保存；相册与小红书识别由人工确认。
- 已确认无在途任务后重启工作台。原始粉剂图片和实况配对素材保留；未实际发布。

手机兼容证据限于用户本次设备，不推断所有 iOS 版本均已验证。
