import XCTest
@testable import PushArmorCore

final class ToastTextTests: XCTestCase {
    func testCopyResult() {
        XCTAssertEqual(ToastText.copied, "Copied")
        XCTAssertEqual(ToastText.copyFailed, "Unable to copy\nSelect the text and copy it by hand")
        let ok = ToastText.copyResult("hello", pasteboardHasText: true)
        XCTAssertEqual(ok.text, "Copied")
        XCTAssertTrue(ok.ok)
        for (v, has) in [("", true), (" \n", true), ("hello", false)] {
            let r = ToastText.copyResult(v, pasteboardHasText: has)
            XCTAssertEqual(r.text, ToastText.copyFailed)
            XCTAssertFalse(r.ok)
        }
    }
}
