# iPhone Live Photo 接收端

用户已批准第二方案：工作台生成 → 手机扫码接收 → 保存为一张Live Photo；粉剂海报真实验收，保留原图，不发布。

工作台为已完成且文件校验通过的Live Photo创建15分钟有效的局域网接收会话。独立监听局域网IPv4地址、随机端口，只暴露当前会话的JPEG/MOV/manifest/保存回执；管理工作台仍只监听127.0.0.1。256位随机能力令牌、可撤销、过期失效、重启失效，来源校验且禁止目录遍历。二维码仅在本机生成，不请求第三方二维码服务。此版同Wi-Fi接收，手机不经过Mac相册；工作台仍运行于Mac上。

iPhone端是SwiftUI轻量原生App，支持内置扫码、系统相机打开自定义链接及粘贴链接；收到后验证源为私有IPv4、本地HTTP、固定路径、禁止重定向；下载两资源核对SHA256与字节数，PHLivePhoto加载预览。用户点保存，才请求相册添加权限，通过一个PHAssetCreationRequest将.photo和.pairedVideo同时保存。保存成功后回执，重复点击不会重复入库；回执失败可重试且不重新保存。临时资源清理，不读取用户相册，不发布。

协议：二维码 xhslive://receive?url=<encoded http://LAN_IP:PORT/v1/transfers/TOKEN>。GET该HTTP地址得到version=1, transferId, title, assetIdentifier, expiresAt, files:{photo:{path:'photo',sha256,size},video:{path:'video',sha256,size}}。GET子路径photo/video下载；POST子路径receipt，JSON {receiptId:UUID,status:'saved',assetIdentifier:manifest.assetIdentifier,environment:'simulator'|'device'}。工作台显示接收端保存回执，仍不自动标记小红书识别通过。

首次安装需Apple签名及用户手机配合。测试覆盖会话过期/撤销/错误令牌/文件篡改/回执幂等、iOS链接和下载验证、模拟器构建与真实文件导入；物理iPhone需实际安装和相册授权后验收。不能把模拟器或原Mac中转验证冒充本轮手机端全流程成功。
