import XCTest
@testable import ReceiverCore
final class ProtocolTests: XCTestCase {
 let token = String(repeating: "A", count: 43)
 func link(_ host: String = "192.168.1.10", suffix: String = "") -> String { "http://\(host):8123/v1/transfers/\(token)\(suffix)" }
 func testPrivateEndpoints() throws {
  for host in ["10.1.2.3", "172.16.0.2", "172.31.255.254", "192.168.1.3"] { XCTAssertEqual(try ReceiverProtocol.endpoint(link(host)).host, host) }
 }
 func testUnsafeEndpointsRejected() {
  for input in [link("8.8.8.8"),link("127.0.0.1"),link("172.32.0.1"),link("localhost"),link("192.168.01.2"),link(suffix:"/photo"),link(suffix:"?x=1"),link(suffix:"#x"),link("user@192.168.1.1"),link().replacingOccurrences(of:"http:",with:"https:"),link().replacingOccurrences(of:":8123",with:""),link().dropLast().description] { XCTAssertThrowsError(try ReceiverProtocol.endpoint(input), input) }
 }
 func testDeepLink() throws {
  var c = URLComponents(); c.scheme="xhslive"; c.host="receive"; c.queryItems=[URLQueryItem(name:"url",value:link())]
  XCTAssertEqual(try ReceiverProtocol.endpoint(c.string!).absoluteString, link())
  XCTAssertThrowsError(try ReceiverProtocol.endpoint(c.string! + "&url=bad"))
 }
 func testIntegrity() throws {
  let bytes = Data("abc".utf8); let hash="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  XCTAssertNoThrow(try ReceiverProtocol.verify(bytes,size:3,sha256:hash))
  XCTAssertThrowsError(try ReceiverProtocol.verify(bytes,size:4,sha256:hash))
  XCTAssertThrowsError(try ReceiverProtocol.verify(Data("abd".utf8),size:3,sha256:hash))
 }
}
