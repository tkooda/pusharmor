import XCTest
import PushArmorCore
@testable import PushArmor

/// I502: the email-code step comes back after process death from the saved request_token,
/// address, and purpose.
@MainActor
final class CodeStepRestoreTests: XCTestCase {
    func testCodeStepRestoredFromSavedState() throws {
        let store = try ScreenshotSample.makeStore()
        let email = "a@example.com"
        // no saved request_token: nothing to restore
        XCTAssertNil(AppModel.restoredCode(me: try store.me(), email: email, purpose: "login"))
        try store.setMe("request_token", .text("rt"))
        // signed in and not logged out: a login code step is stale
        XCTAssertNil(AppModel.restoredCode(me: try store.me(), email: email, purpose: "login"))
        try store.setMe("logged_out", .int(1))
        XCTAssertEqual(AppModel.restoredCode(me: try store.me(), email: email, purpose: "login"),
                       .code(email: email, purpose: .login))
        XCTAssertNil(AppModel.restoredCode(me: try store.me(), email: nil, purpose: "login"))
        XCTAssertNil(AppModel.restoredCode(me: try store.me(), email: email, purpose: nil))
        XCTAssertNil(AppModel.restoredCode(me: try store.me(), email: email, purpose: "delete-account"))
        // removed: the register code step comes back
        try store.wipe()
        try store.setMe("request_token", .text("rt"))
        XCTAssertEqual(AppModel.restoredCode(me: try store.me(), email: email, purpose: "register"),
                       .code(email: email, purpose: .register))
    }
}
