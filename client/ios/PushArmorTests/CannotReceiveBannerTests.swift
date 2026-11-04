import XCTest
import PushArmorCore
@testable import PushArmor

/// notifications off: a banner on the tabs and the logged-out screen that stays until its X
/// is tapped and shows again on the next app open. A relay-side fault shows it on the tabs.
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

    func testRelayFaultShowsItOnTheTabs() {
        let model = AppModel()
        model.phase = .main
        model.relayFault = true
        XCTAssertTrue(model.showsCannotReceive)
        model.cannotReceiveDismissed = true
        XCTAssertFalse(model.showsCannotReceive)
        model.cannotReceiveDismissed = false
        model.phase = .signedOut
        XCTAssertFalse(model.showsCannotReceive)
        XCTAssertEqual(S.relayFaultApple, "The relay server cannot reach Apple's push service right now. "
                       + "This is not a problem on this device. Try again later.")
    }

    /// The relay server does not take this device's push service: shown on the tabs.
    func testPushNotSupportedShowsItOnTheTabs() {
        let model = AppModel()
        model.phase = .main
        model.pushUnsupported = true
        XCTAssertTrue(model.showsCannotReceive)
        model.phase = .signedOut
        XCTAssertFalse(model.showsCannotReceive)
        XCTAssertEqual(ErrorCopy.Reason.pushNotSupported.line, "This device's push service is not supported yet.")
    }

    /// Check again is on every banner: notifications off (tabs and logged-out screen, beside
    /// Open notification settings on the right) and the relay-side fault.
    func testCheckAgainIsOnEveryBanner() {
        XCTAssertEqual(CannotReceiveBanner.actions(notificationsOff: true).map(\.rawValue),
                       ["Check again", "Open notification settings"])
        XCTAssertEqual(CannotReceiveBanner.actions(notificationsOff: false).map(\.rawValue), ["Check again"])
    }

    /// The line after Check again for each outcome.
    func testCheckAgainOutcomeLines() {
        XCTAssertEqual(AppModel.checkLine(nil), "Still cannot receive messages.")
        XCTAssertEqual(AppModel.checkLine(.sent), "Working")
        XCTAssertEqual(AppModel.checkLine(.relay), "Still cannot receive messages.")
        XCTAssertEqual(AppModel.checkLine(.gone), "Still cannot receive messages.")
        XCTAssertEqual(AppModel.checkLine(.failed), "Still cannot receive messages.")
        XCTAssertEqual(AppModel.checkLine(PushCheckResult(word: "other")), "Still cannot receive messages.")
        XCTAssertNil(AppModel.checkLine(.noAddress))
        XCTAssertEqual(AppModel.checkLine(.unavailable), "Unable to check right now. Try again later.")
    }

    func testPushRegistrationFailureAloneDoesNotShowIt() {
        let model = AppModel()
        model.phase = .main
        model.pushRegisterFailed = true
        XCTAssertFalse(model.showsCannotReceive)
    }
}
