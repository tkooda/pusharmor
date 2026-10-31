import XCTest
import PushArmorCore
@testable import PushArmor

/// I465: once this device is logged out or removed, the main screen (Settings included)
/// gives way to the log-in screen on the next reload.
@MainActor
final class SignedOutRoutingTests: XCTestCase {
    func testMainGivesWayWhenLoggedOutOrRemoved() throws {
        let store = try ScreenshotSample.makeStore()
        XCTAssertNil(AppModel.phaseAfterReload(.main, me: try store.me()))
        try store.setMe("logged_out", .int(1))
        XCTAssertEqual(AppModel.phaseAfterReload(.main, me: try store.me()), .signedOut)
        try store.wipe()
        XCTAssertEqual(AppModel.phaseAfterReload(.main, me: try store.me()), .removed)
        // other screens route themselves
        XCTAssertNil(AppModel.phaseAfterReload(.signedOut, me: try store.me()))
    }
}
