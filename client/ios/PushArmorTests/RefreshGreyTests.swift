import XCTest
@testable import PushArmor

/// Refresh and pull-to-refresh on the Devices screen are greyed 10 s after use, with no countdown.
@MainActor
final class RefreshGreyTests: XCTestCase {
    func testGreyTimeIsTenSeconds() {
        XCTAssertEqual(AppModel.refreshGreySeconds, 10)
        XCTAssertLessThan(AppModel().refreshGreyUntil, Date())   // a new model starts with Refresh on
    }
}
