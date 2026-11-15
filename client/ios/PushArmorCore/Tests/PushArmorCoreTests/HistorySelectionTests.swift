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

    func testSelectAllIsTriState() {
        var s = HistorySelection()
        let shown: [Int64] = [1, 2, 3]
        XCTAssertEqual(s.allState(of: shown), .empty)
        s.toggleAll(shown)
        XCTAssertTrue(s.active)
        XCTAssertEqual(s.ids, [1, 2, 3])
        XCTAssertEqual(s.allState(of: shown), .all)
        s.toggle(2)
        XCTAssertEqual(s.allState(of: shown), .partial)
        // from some, a tap checks every row
        s.toggleAll(shown)
        XCTAssertEqual(s.allState(of: shown), .all)
        // from all, a tap clears every row and ends the mode
        s.toggleAll(shown)
        XCTAssertFalse(s.active)
        XCTAssertEqual(s.allState(of: shown), .empty)
        // no rows: nothing to select
        s.toggleAll([])
        XCTAssertFalse(s.active)
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
