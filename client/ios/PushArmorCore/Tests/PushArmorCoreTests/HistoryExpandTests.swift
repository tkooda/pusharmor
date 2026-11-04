import XCTest
@testable import PushArmorCore

final class HistoryExpandTests: XCTestCase {
    func testTapOpensAnotherRowAndClosesTheOpenOne() {
        var open: Int64? = nil
        open = HistoryExpand.tap(open: open, tapped: 1)
        XCTAssertEqual(open, 1)
        open = HistoryExpand.tap(open: open, tapped: 2)   // one tap on another row opens it
        XCTAssertEqual(open, 2)
        open = HistoryExpand.tap(open: open, tapped: 1)
        XCTAssertEqual(open, 1)
    }

    func testTapOnTheOpenRowClosesIt() {
        var open: Int64? = HistoryExpand.tap(open: nil, tapped: 2)
        open = HistoryExpand.tap(open: open, tapped: 2)
        XCTAssertNil(open)
        open = HistoryExpand.tap(open: open, tapped: 2)
        XCTAssertEqual(open, 2)
    }
}
