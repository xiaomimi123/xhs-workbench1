import XCTest
@testable import ReceiverCore
final class ManifestTests: XCTestCase {
 func fixture(_ updates: [String:Any] = [:]) throws -> Manifest {
  var object: [String:Any] = ["version":1,"transferId":"transfer_123","title":"测试","assetIdentifier":"asset-123","expiresAt":"2099-10-19T11:00:00.123Z","files":["photo":["path":"photo","sha256":String(repeating:"a",count:64),"size":123],"video":["path":"video","sha256":String(repeating:"b",count:64),"size":456]]]
  object.merge(updates) { _,new in new }
  return try JSONDecoder().decode(Manifest.self,from:JSONSerialization.data(withJSONObject:object))
 }
 func testAcceptsMillisecondExpiry() throws { XCTAssertNoThrow(try fixture().validate()) }
 func testRejectsExpiredOrUnsupportedManifest() throws {
  for update:[String:Any] in [["version":2],["expiresAt":"2000-01-01T00:00:00Z"],["expiresAt":"invalid"],["transferId":""],["assetIdentifier":""]] { XCTAssertThrowsError(try fixture(update).validate()) }
 }
 func testRejectsTraversalInvalidHashAndOversize() throws {
  for bad:[String:Any] in [["path":"../photo","sha256":String(repeating:"a",count:64),"size":1],["path":"photo","sha256":"bad","size":1],["path":"photo","sha256":String(repeating:"a",count:64),"size":0],["path":"photo","sha256":String(repeating:"a",count:64),"size":30*1024*1024+1]] {
   XCTAssertThrowsError(try fixture(["files":["photo":bad,"video":["path":"video","sha256":String(repeating:"b",count:64),"size":1]]]).validate())
  }
 }
}
