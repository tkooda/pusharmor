import XCTest

/// The bottom banner shows and speaks its text through ToastText.shown, so no line of a
/// banner ends with a period. Banner layout is view code, so this reads the app's source.
final class ToastBannerTests: XCTestCase {
    func testBannerTextAndAnnouncementDropTrailingPeriods() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/RootView.swift")
        let root = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(root.contains("UIAccessibility.post(notification: .announcement, argument: ToastText.shown(t))"))
        XCTAssertTrue(root.contains("Text(ToastText.shown(t))"))
        XCTAssertFalse(root.contains("Text(t)"))
    }
}
