import XCTest
@testable import PushArmorCore

final class HistorySelectionTests: XCTestCase {
    func testLongPressStartsWithThatRowChecked() {
        var s = HistorySelection()
        XCTAssertFalse(s.active)
        s.toggle(1)   // a tap outside the mode does nothing
        XCTAssertFalse(s.active)
        s.start(5)
        XCTAssertTrue(s.active)
        XCTAssertTrue(s.contains(5))
        XCTAssertFalse(s.contains(6))
    }

    func testTapTogglesAndUncheckingAllExits() {
        var s = HistorySelection()
        s.start(5)
        s.toggle(6)
        XCTAssertEqual(s.count, 2)
        s.toggle(5)
        s.toggle(6)
        XCTAssertFalse(s.active)
        XCTAssertEqual(s.count, 0)
    }

    func testLabelsSingularAndPlural() {
        var s = HistorySelection()
        s.start(1)
        XCTAssertEqual(s.deleteLabel, "Delete 1 selected")
        XCTAssertEqual(s.confirmTitle, "Delete 1 message?")
        s.toggle(2)
        XCTAssertEqual(s.deleteLabel, "Delete 2 selected")
        XCTAssertEqual(s.confirmTitle, "Delete 2 messages?")
    }

    func testKeepOnlyVisibleCanEndTheMode() {
        var s = HistorySelection()
        s.start(1)
        s.toggle(2)
        s.keep(only: [2, 3])
        XCTAssertEqual(s.ids, [2])
        s.keep(only: [9])
        XCTAssertFalse(s.active)
    }
}
