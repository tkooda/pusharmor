import XCTest
@testable import PushArmorCore

final class MessageActionsTests: XCTestCase {
    func testLinkAndPhoneActionOrder() {
        XCTAssertEqual(MessageActions.actions(forType: "url"), [.copy, .open, .share])
        XCTAssertEqual(MessageActions.actions(forType: "tel"), [.copy, .open, .share])
    }

    func testTextActionOrderHasNoOpen() {
        XCTAssertEqual(MessageActions.actions(forType: "text"), [.read, .copy, .share, .save])
    }

    func testShortTextDoesNotScroll() {
        XCTAssertFalse(MessageActions.scrolls("one\ntwo\nthree"))
        XCTAssertFalse(MessageActions.scrolls("hello"))
    }

    func testFourLinesScroll() {
        XCTAssertTrue(MessageActions.scrolls("a\nb\nc\nd"))
    }

    func testLongWrappedLineScrolls() {
        XCTAssertTrue(MessageActions.scrolls(String(repeating: "x", count: 200)))
    }

    func testSaveFilenameUsesLocalTime() {
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(MessageActions.saveFilename(epoch: 1_793_000_000, timeZone: utc), "2026-10-26_073320_message.txt")
        let ny = TimeZone(identifier: "America/New_York")!
        XCTAssertEqual(MessageActions.saveFilename(epoch: 1_793_000_000, timeZone: ny), "2026-10-26_033320_message.txt")
    }
}
