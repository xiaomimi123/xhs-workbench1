import XCTest
final class ReceiverUITests: XCTestCase {
 func testReceivePreviewAndSave() throws {
  let value=ProcessInfo.processInfo.environment["XHS_RECEIVER_TEST_URL"] ?? ""
  guard !value.isEmpty else { throw XCTSkip("Supply TEST_RUNNER_XHS_RECEIVER_TEST_URL with a live LAN transfer link.") }
  let app=XCUIApplication(); app.launch()
  let field=app.textFields["粘贴接收链接"]
  XCTAssertTrue(field.waitForExistence(timeout:10)); field.tap(); field.typeText(value)
  app.buttons["接收"].tap()
  let save=app.buttons["保存到相册"]
  XCTAssertTrue(save.waitForExistence(timeout:120), app.staticTexts["receiver-status"].label)
  app.swipeUp()
  let preview=XCTAttachment(screenshot:app.screenshot()); preview.name="Verified Live Photo Preview"; preview.lifetime = .keepAlways; add(preview)
  addUIInterruptionMonitor(withDescription:"Photos add permission") { alert in
   for name in ["Allow Access to Add Photos", "Allow", "允许添加照片", "允许"] { if alert.buttons[name].exists { alert.buttons[name].tap(); return true } }
   return false
  }
  save.tap()
  let status=app.staticTexts["receiver-status"]
  let predicate=NSPredicate(format:"label CONTAINS %@", "已保存为一张 Live Photo")
  XCTAssertEqual(XCTWaiter.wait(for:[expectation(for:predicate,evaluatedWith:status)],timeout:60),.completed)
  let receipt=XCTAttachment(screenshot:app.screenshot()); receipt.name="Saved and Receipt Acknowledged"; receipt.lifetime = .keepAlways; add(receipt)
  XCTAssertFalse(save.exists)
 }
 func testRestartDoesNotSaveAgain() throws {
  let value=ProcessInfo.processInfo.environment["XHS_RECEIVER_TEST_URL"] ?? ""
  guard !value.isEmpty else { throw XCTSkip("Supply an already saved live transfer link.") }
  let app=XCUIApplication(); app.launch()
  let field=app.textFields["粘贴接收链接"]
  XCTAssertTrue(field.waitForExistence(timeout:10)); field.tap(); field.typeText(value)
  app.buttons["接收"].tap()
  let status=app.staticTexts["receiver-status"]
  let predicate=NSPredicate(format:"label CONTAINS %@", "此会话已保存并回执")
  XCTAssertEqual(XCTWaiter.wait(for:[expectation(for:predicate,evaluatedWith:status)],timeout:30),.completed)
  XCTAssertFalse(app.buttons["保存到相册"].exists)
 }
}
