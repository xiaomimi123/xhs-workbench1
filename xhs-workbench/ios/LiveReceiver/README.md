# LiveReceiver

独立 SwiftUI iOS 接收端，最低 iOS 17。Scheme：`LiveReceiver`；Bundle ID：`com.xhsworkbench.LiveReceiver`。不依赖第三方库。

## 构建和安装

在 Xcode 打开 `LiveReceiver.xcodeproj`，选择 `LiveReceiver` scheme。真机安装需要在 Signing & Capabilities 中选择自己的 Apple Development Team、连接 iPhone，并按系统要求开启开发者模式。工程没有预设团队或签名证书。

模拟器无签名构建：

```sh
xcodebuild -project LiveReceiver.xcodeproj -scheme LiveReceiver \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/xhs-live-receiver-build CODE_SIGNING_ALLOWED=NO build
swift test
```

`generate-project.py` 可重新生成工程和 Info.plist；新增源文件时同步其文件列表。共享 scheme 已入工程。

## 使用

手机和工作台位于同一 Wi-Fi。工作台创建接收会话后，用 App 扫码、系统相机打开 `xhslive://receive?url=...`，或粘贴链接并点“接收”。首次连接允许局域网权限。下载完成后长按 Live Photo 预览，点击“保存到相册”才请求添加权限。未使用相册读取权限。

相册单次创建请求同时提交 `.photo` 和 `.pairedVideo`。只有 Photos 成功后才发回执；回执失败可重试，不再次保存。保存状态和固定回执 UUID 以原子文件持久化；保存事务中断时保守阻止该会话再次保存，提示先检查相册。记录损坏时停止接收，避免静默重置导致重复保存。

## 协议和边界

只接受显式端口的 RFC1918 私有 IPv4 HTTP 地址以及 `/v1/transfers/` 后 43 位 base64url 令牌。禁止域名、IPv6、公网、loopback、userinfo、query、fragment、编码路径和所有重定向。manifest 最大 64 KiB，JPEG 最大 30 MiB，MOV 最大 150 MiB，资源读取过程中严格限制字节数并核对 SHA256；固定资源路径，不信任 manifest 中的任意 URL。HTTP 使用 ephemeral URLSession，不保存 cookie/cache，不后台传输。

数字 IP 的局域网明文 HTTP 需要 Info.plist 的 ATS 配置；应用级 URL 白名单仍限制全部接收请求到上述私有地址。权限说明包括相机、局域网和相册添加。

回执包含 `receiptId`, `status: saved`, `assetIdentifier`，以及编译环境标记 `environment: simulator | device`。模拟器验证不能当作物理 iPhone 或小红书识别验证。

清理：新会话开始、下载/预览失败、保存成功时移除临时资源；启动时清理上次崩溃残留。保存记录保留用于防重复。撤销/过期后已下载并预览的文件仍可由用户保存；回执若失效会明确显示失败。

## 原生 UI 验证

`LiveReceiverUITests` 使用真实局域网会话，在界面输入链接、等待 PHLivePhoto 预览、点击保存，并等待服务器回执。只应在专用测试模拟器运行；不使用此测试操作个人手机相册。未提供环境变量时测试跳过。

```sh
# 在独立测试模拟器安装 App 后，可预授权该模拟器的相册添加权限：
xcrun simctl privacy SIMULATOR_UUID grant photos-add com.xhsworkbench.LiveReceiver
# 用新建、未接收的短期会话；不要把能力链接写入提交或共享日志。
TEST_RUNNER_XHS_RECEIVER_TEST_URL='工作台接收链接' \
  xcodebuild -project LiveReceiver.xcodeproj -scheme LiveReceiver \
  -destination 'id=SIMULATOR_UUID' CODE_SIGNING_ALLOWED=NO test
```

测试结果保存真实预览和保存成功截图。此测试需要局域网可达、有效的真实 JPEG/MOV 配对文件；二维码相机扫描仍需真机验证。
