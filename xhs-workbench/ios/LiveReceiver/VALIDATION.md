# Validation — 2026-10-19

Environment: Xcode 27.1 (27A9275), iOS 26.5 (23F77), dedicated iPhone 17 Pro simulator named `LiveReceiver Validation` (`43E7D856-EAE5-4569-87C6-9EFDD504DC36`). No physical iPhone was used.

- `swift test`: 7 XCTest cases passed, 0 failures. Coverage: private IPv4 allowlist, malformed/unsafe links, custom URL decoding, SHA256 and exact byte count, expiry with milliseconds, invalid/expired manifest, path traversal, invalid hash and oversize manifest resources.
- Protocol parser/integrity tests were observed failing first: 4 tests, 20 failed assertions against stubs, then passing after implementation. Manifest tests were added as additional coverage.
- Unsigned simulator `xcodebuild ... build`: succeeded.
- `xcodebuild ... build-for-testing`: succeeded.
- Native `testReceivePreviewAndSave`: passed against the real powder-poster JPEG/MOV session in 13.036 seconds. The test entered the link in the App, waited for a PHLivePhoto preview, tapped Save, and waited for the acknowledged-save status. The App created a Photos asset using `.photo` plus `.pairedVideo`, then sent the real receipt with `environment: simulator`.
- Native `testRestartDoesNotSaveAgain`: passed in 9.843 seconds after restarting the App and receiving the same session. The App recognized its durable save record and exposed no Save button.

Initial result bundle: `/tmp/xhs-live-receiver-uitests.xcresult`. Local test logs may contain short-lived capability links; do not publish them. Screenshots from the first run showed an input keyboard remaining open; the final UI now dismisses it on receive, uses a compact navigation title, and clears the input after successful receipt/preview.

Apple runtime emitted accessibility duplicate-class / host build-version diagnostics and a framework AppIntents metadata warning. No Swift source compilation error occurred and the native tests passed.

Still requires physical-device acceptance: signing/install, system-camera custom-link handoff, physical camera scan, actual Wi-Fi/local-network permission behavior, user Photos add permission, long-press motion, and target-app recognition. Simulator success is not evidence of iPhone or Xiaohongshu acceptance.

Final revised UI run: both native tests passed against a fresh real transfer (`testReceivePreviewAndSave`: 12.337 seconds; `testRestartDoesNotSaveAgain`: 9.897 seconds), 2 tests / 0 failures. Final result bundle: `/tmp/xhs-live-receiver-final.xcresult`; extracted screenshots: `/tmp/xhs-live-receiver-final-evidence/`. This run includes the keyboard dismissal, compact title, cleared link field, network cancellation, and receipt retry persistence corrections.

Final xcodebuild returned exit code 0 / `TEST SUCCEEDED`. Its post-test `simctl diagnose` collector stalled after the tests completed; that diagnostic-only subprocess was gracefully terminated, allowing the successful result bundle to close normally. This did not interrupt App execution or either XCTest case. Screenshots were exported from the result bundle and visually inspected; token input is empty. Copies are `evidence/simulator-live-preview.png` and `evidence/simulator-saved-receipt.png`.

Read-only inspection of this dedicated simulator's App data container confirmed two acknowledged save records (two distinct test sessions) and zero temporary transfer files remaining.
