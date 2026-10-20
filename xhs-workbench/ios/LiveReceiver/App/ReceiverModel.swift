import SwiftUI
import Photos
import PhotosUI

final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
 func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct SaveRecord: Codable {
 let receiptId: String
 let assetIdentifier: String
 var state: String
}
@MainActor final class ReceiverModel: ObservableObject {
 @Published var link = ""
 @Published var status = "同一 Wi-Fi 下扫码或粘贴工作台接收链接。"
 @Published var busy = false
 @Published var livePhoto: PHLivePhoto?
 @Published var title = "Live Photo 接收"
 @Published var saved = false
 @Published var receiptPending = false
 private var endpoint: URL?
 private var manifest: Manifest?
 private var folder: URL?
 private let client = LocalHTTPClient()
 private let recordURL: URL
 private var records: [String:SaveRecord] = [:]
 private var recordsReadable = true
 init() {
  let base = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
  try? FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
  recordURL = base.appendingPathComponent("saved-transfers.json")
  if FileManager.default.fileExists(atPath:recordURL.path) {
   do { records = try JSONDecoder().decode([String:SaveRecord].self,from:Data(contentsOf:recordURL)) }
   catch { recordsReadable=false }
  }
  let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("LiveReceiver")
  try? FileManager.default.removeItem(at:tmp)
 }
 private func persist() throws { try JSONEncoder().encode(records).write(to:recordURL,options:.atomic) }
 func clear() {
  livePhoto=nil
  if let folder { try? FileManager.default.removeItem(at:folder) }
  folder=nil
 }
 func receive(_ text: String) async {
  guard !busy else { return }; busy=true; defer { busy=false }
  guard recordsReadable else { status="保存记录无法读取，已停止接收以防重复保存。请保留 App 数据并检查设备储存空间。"; return }
  clear(); manifest=nil; endpoint=nil; saved=false; receiptPending=false
  do {
   let url=try ReceiverProtocol.endpoint(text)
   status="正在连接工作台…"
   let data=try await client.fetch(url,limit:65536)
   let m=try JSONDecoder().decode(Manifest.self,from:data); try m.validate()
   endpoint=url; manifest=m; title=m.title
   if let record=records[m.transferId] {
    guard record.assetIdentifier == m.assetIdentifier else { throw ReceiverError.invalidManifest }
    saved=true; link=""
    receiptPending = record.state == "saved"
    status = record.state == "saving" ? "上次保存被中断，结果不确定。请先检查相册；为避免重复，本接收会话不会再次保存。" : (record.state == "acknowledged" ? "此会话已保存并回执，不会重复保存。" : "此会话已保存，可重试回执。")
    return
   }
   status="正在下载并校验照片和视频…"
   let dir=FileManager.default.temporaryDirectory.appendingPathComponent("LiveReceiver").appendingPathComponent(UUID().uuidString)
   try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true); folder=dir
   for (resource,name) in [(m.files.photo,"photo.jpg"),(m.files.video,"video.mov")] {
    let content=try await client.fetch(url.appendingPathComponent(resource.path),limit:resource.size)
    try ReceiverProtocol.verify(content,size:resource.size,sha256:resource.sha256)
    try content.write(to:dir.appendingPathComponent(name),options:.atomic)
   }
   try m.validate()
   livePhoto = try await preview([dir.appendingPathComponent("photo.jpg"),dir.appendingPathComponent("video.mov")])
   link=""
   status="校验完成。长按预览；点保存后才会请求相册添加权限。"
  } catch { clear(); status=error.localizedDescription }
 }
 private func preview(_ urls: [URL]) async throws -> PHLivePhoto {
  try await withCheckedThrowingContinuation { continuation in
   PHLivePhoto.request(withResourceFileURLs:urls,placeholderImage:nil,targetSize:CGSize(width:1000,height:1000),contentMode:.aspectFit) { photo,info in
    if (info[PHLivePhotoInfoIsDegradedKey] as? Bool) == true { return }
    if let photo { continuation.resume(returning:photo) }
    else { continuation.resume(throwing:(info[PHLivePhotoInfoErrorKey] as? Error) ?? ReceiverError.integrity) }
   }
  }
 }
 func save() async {
  guard !busy, !saved, livePhoto != nil, let m=manifest, let folder else { return }
  busy=true; defer { busy=false }
  do {
   let auth=await PHPhotoLibrary.requestAuthorization(for:.addOnly)
   guard auth == .authorized || auth == .limited else { status="未获得相册添加权限，可在系统设置中开启后再试。"; return }
   records[m.transferId]=SaveRecord(receiptId:UUID().uuidString,assetIdentifier:m.assetIdentifier,state:"saving")
   try persist()
   do {
    try await PHPhotoLibrary.shared().performChanges {
     let request=PHAssetCreationRequest.forAsset()
     request.addResource(with:.photo,fileURL:folder.appendingPathComponent("photo.jpg"),options:nil)
     request.addResource(with:.pairedVideo,fileURL:folder.appendingPathComponent("video.mov"),options:nil)
    }
   } catch { records.removeValue(forKey:m.transferId); try? persist(); throw error }
   saved=true; receiptPending=true
   records[m.transferId]?.state="saved"
   // Persist before receipt; a crash during Photos commit remains conservatively blocked.
   try persist(); clear()
   await sendReceipt()
  } catch { status=error.localizedDescription }
 }
 func retryReceipt() async {
  guard !busy, saved, receiptPending else { return }
  busy=true; defer { busy=false }; await sendReceipt()
 }
 private func sendReceipt() async {
  guard let m=manifest,let endpoint,let record=records[m.transferId],record.state == "saved" else { return }
  do {
   #if targetEnvironment(simulator)
   let environment = "simulator"
   #else
   let environment = "device"
   #endif
   let body=try JSONSerialization.data(withJSONObject:["receiptId":record.receiptId,"status":"saved","assetIdentifier":record.assetIdentifier,"environment":environment])
   _=try await client.fetch(endpoint.appendingPathComponent("receipt"),limit:65536,body:body)
   records[m.transferId]?.state="acknowledged"
   do { try persist() } catch { records[m.transferId]?.state="saved"; throw error }
   receiptPending=false; status="已保存为一张 Live Photo，工作台已收到回执。"
  } catch { receiptPending=true; status="已保存到相册，但回执失败。重试回执不会重复保存。\n" + error.localizedDescription }
 }
}

// Runs outside the UI actor; byte-by-byte bounded reads cannot block preview controls.
final class LocalHTTPClient: @unchecked Sendable {
 private let session: URLSession
 init() {
  let c = URLSessionConfiguration.ephemeral
  c.timeoutIntervalForRequest = 20; c.timeoutIntervalForResource = 180
  c.urlCache = nil; c.httpCookieStorage = nil; c.httpShouldSetCookies = false
  session = URLSession(configuration:c,delegate:NoRedirect(),delegateQueue:nil)
 }
 func fetch(_ url: URL, limit: Int, body: Data? = nil) async throws -> Data {
  var request=URLRequest(url:url)
  if let body { request.httpMethod="POST"; request.httpBody=body; request.setValue("application/json",forHTTPHeaderField:"Content-Type") }
  let (bytes,response) = try await session.bytes(for:request)
  defer { bytes.task.cancel() }
  guard let http=response as? HTTPURLResponse, (200...299).contains(http.statusCode), response.url == url else { throw ReceiverError.network }
  guard response.expectedContentLength <= Int64(limit) else { throw ReceiverError.tooLarge }
  var data=Data(); data.reserveCapacity(min(limit,1024*1024))
  for try await byte in bytes {
   guard data.count < limit else { throw ReceiverError.tooLarge }
   data.append(byte)
  }
  return data
 }
}
