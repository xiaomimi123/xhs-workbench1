import Foundation
import CryptoKit
public enum ReceiverError: LocalizedError {
 case invalidLink, invalidManifest, integrity, network, tooLarge
 public var errorDescription: String? {
  switch self {
  case .invalidLink: return "链接无效：请使用工作台生成的同一 Wi-Fi 接收链接。"
  case .invalidManifest: return "接收会话无效或已过期，请在工作台重新生成。"
  case .integrity: return "文件大小或 SHA256 校验失败，请重新生成。"
  case .network: return "连接失败或会话已撤销，请检查同一 Wi-Fi 和局域网权限。"
  case .tooLarge: return "文件超过接收大小限制。"
  }
 }
}
public enum ReceiverProtocol {
 public static func endpoint(_ text: String) throws -> URL {
  var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if raw.hasPrefix("xhslive:") {
   guard let outer = URLComponents(string:raw), outer.scheme == "xhslive", outer.host == "receive", outer.path.isEmpty, outer.user == nil, outer.password == nil, outer.port == nil, outer.fragment == nil, let items = outer.queryItems, items.count == 1, items[0].name == "url", let value = items[0].value else { throw ReceiverError.invalidLink }
   raw = value
  }
  guard let c = URLComponents(string:raw), c.scheme == "http", c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, let port=c.port, (1...65535).contains(port), let host=c.host, !raw.contains("%"), let url=c.url else { throw ReceiverError.invalidLink }
  let parts = host.split(separator:".",omittingEmptySubsequences:false)
  guard parts.count == 4 else { throw ReceiverError.invalidLink }
  let nums = parts.compactMap { Int($0) }
  guard nums.count == 4, zip(parts,nums).allSatisfy({ String($0.1) == String($0.0) && (0...255).contains($0.1) }), nums[0] == 10 || (nums[0] == 172 && (16...31).contains(nums[1])) || (nums[0] == 192 && nums[1] == 168), c.path.range(of:"^/v1/transfers/[A-Za-z0-9_-]{43}$", options:.regularExpression) != nil else { throw ReceiverError.invalidLink }
  return url
 }
 public static func verify(_ data: Data, size: Int, sha256: String) throws {
  guard data.count == size, SHA256.hash(data:data).map({String(format:"%02x",$0)}).joined() == sha256.lowercased() else { throw ReceiverError.integrity }
 }
}
public struct Manifest: Codable, Sendable {
 public struct Resource: Codable, Sendable { public let path: String; public let sha256: String; public let size: Int }
 public struct Files: Codable, Sendable { public let photo: Resource; public let video: Resource }
 public let version: Int
 public let transferId: String
 public let title: String
 public let assetIdentifier: String
 public let expiresAt: String
 public let files: Files
 public func validate(now: Date = Date()) throws {
  let formatter = ISO8601DateFormatter(); formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  let date = formatter.date(from:expiresAt) ?? ISO8601DateFormatter().date(from:expiresAt)
  guard version == 1, !transferId.isEmpty, transferId.count <= 128, !assetIdentifier.isEmpty, assetIdentifier.count <= 128, title.count <= 1000, let date, date > now else { throw ReceiverError.invalidManifest }
  for (r,path,limit) in [(files.photo,"photo",30*1024*1024),(files.video,"video",150*1024*1024)] {
   guard r.path == path, r.size > 0, r.size <= limit, r.sha256.range(of:"^[a-fA-F0-9]{64}$",options:.regularExpression) != nil else { throw ReceiverError.invalidManifest }
  }
 }
}
