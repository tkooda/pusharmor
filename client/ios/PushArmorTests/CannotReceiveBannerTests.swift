import XCTest
import PushArmorCore
@testable import PushArmor

/// notifications off: a banner on the tabs and the logged-out screen that stays until its X
/// is tapped and shows again on the next app open.
@MainActor
final class CannotReceiveBannerTests: XCTestCase {
    func testBannerShowsWhileNotificationsAreOff() {
        let model = AppModel()
        model.phase = .main
        XCTAssertFalse(model.showsCannotReceive)
        model.notificationsOff = true
        XCTAssertTrue(model.showsCannotReceive)
        model.phase = .signedOut
        XCTAssertTrue(model.showsCannotReceive)
        model.phase = .welcome
        XCTAssertFalse(model.showsCannotReceive)
        XCTAssertEqual(S.cannotReceive, "This device cannot receive messages.")
        XCTAssertEqual(S.allowNotifications, "Allow notifications for PushArmor in Settings.")
    }

    func testDismissHidesItUntilTheNextAppOpen() async {
        let model = AppModel()
        model.phase = .main
        model.notificationsOff = true
        model.cannotReceiveDismissed = true
        XCTAssertFalse(model.showsCannotReceive)
        await model.onForeground()
        XCTAssertFalse(model.cannotReceiveDismissed)
    }

    func testPushRegistrationFailureAloneDoesNotShowIt() {
        let model = AppModel()
        model.phase = .main
        model.pushRegisterFailed = true
        XCTAssertFalse(model.showsCannotReceive)
    }
}
