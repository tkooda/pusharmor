import XCTest
@testable import PushArmor

/// Refresh and pull-to-refresh on the Devices screen are greyed 10 s after use, with no countdown.
@MainActor
final class RefreshGreyTests: XCTestCase {
    func testGreyTimeIsTenSeconds() {
        XCTAssertEqual(AppModel.refreshGreySeconds, 10)
        XCTAssertLessThan(AppModel().refreshGreyUntil, Date())   // a new model starts with Refresh on
    }

    /// Try again on a pairing card is greyed 10 s after a tap; a tap meanwhile does nothing.
    func testTryAgainGreyTimeIsTenSeconds() {
        let m = AppModel()
        let t = Date()
        XCTAssertFalse(m.tryAgainGreyed("p1", at: t))
        XCTAssertTrue(m.startTryAgainGrey("p1", at: t))
        XCTAssertTrue(m.tryAgainGreyed("p1", at: t.addingTimeInterval(9.9)))
        XCTAssertFalse(m.startTryAgainGrey("p1", at: t.addingTimeInterval(9.9)))
        XCTAssertFalse(m.tryAgainGreyed("p2", at: t))
        XCTAssertFalse(m.tryAgainGreyed("p1", at: t.addingTimeInterval(10)))
        XCTAssertTrue(m.startTryAgainGrey("p1", at: t.addingTimeInterval(10)))
    }
}
