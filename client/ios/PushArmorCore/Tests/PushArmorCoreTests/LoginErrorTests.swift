import XCTest
@testable import PushArmorCore

/// a failed login says why when the relay server or the network gives a cause.
final class LoginErrorTests: XCTestCase {
    func testLoginErrorGivesTheCause() {
        XCTAssertEqual(S.loginError(.network, .sendCode),
                       "Unable to send the code.\nThe relay server could not be reached. Check your internet connection and try again.")
        XCTAssertEqual(S.loginError(.badEmail, .sendCode),
                       "Unable to send the code.\nOnly email addresses with plain ASCII characters are supported.")
        XCTAssertEqual(S.loginError(.emailSendFailed, .sendCode),
                       "Unable to send the code.\nThe relay server could not send the email. Try again.")
        XCTAssertEqual(S.loginError(.rateLimited(30), .sendCode), "Unable to send the code.\nToo many tries. Try again in 30 seconds.")
        XCTAssertEqual(S.loginError(.rateLimited(1), .sendCode), "Unable to send the code.\nToo many tries. Try again in 1 second.")
        XCTAssertEqual(S.loginError(.rateLimited(61), .sendCode), "Unable to send the code.\nToo many tries. Try again in 2 minutes.")
        XCTAssertEqual(S.loginError(.rateLimited(60), .sendCode), "Unable to send the code.\nToo many tries. Try again in 60 seconds.")
        XCTAssertEqual(S.loginError(.failed(403, "turnstile failed"), .sendCode),
                       "Unable to send the code.\nThe security check did not finish. Try again.")
        XCTAssertEqual(S.loginError(.failed(401, "wrong code"), .checkCode),
                       "Unable to check the code.\nThe code is not correct. Check the newest email from PushArmor and try again.")
        XCTAssertEqual(S.loginError(.failed(401, "code expired"), .checkCode),
                       "Unable to check the code.\nThe code expired. Request a new code to continue.")
        XCTAssertEqual(S.loginError(.failed(401, "ticket expired"), .checkCode), "Unable to check the code.\nThe login expired. Log in again.")
        XCTAssertEqual(S.loginError(.failed(403, "banned"), .checkCode), "Unable to check the code.\nThis account is blocked.")
        XCTAssertEqual(S.loginError(.failed(500, nil), .checkCode),
                       "Unable to check the code.\nThe relay server is not working right now. Try again later.")
        XCTAssertEqual(S.loginError(.failed(401, "invalid id_token"), .loginGoogle),
                       "Unable to log in with Google.\nGoogle did not confirm the login. Try again.")
        XCTAssertEqual(S.loginError(.failed(401, "invalid id_token"), .loginApple),
                       "Unable to log in with Apple.\nApple did not confirm the login. Try again.")
        XCTAssertEqual(S.loginError(.failed(401, "email not verified"), .loginGoogle),
                       "Unable to log in with Google.\nThis Google account has no verified email address.")
        XCTAssertEqual(S.loginError(.failed(400, "x"), .login), "Unable to log in.\nTry again.")
        XCTAssertEqual(ErrorCopy.text(.loginGoogle, .windowClosed), "Unable to log in with Google.\nThe login window was closed. Try again.")
        XCTAssertEqual(S.launchFailedTitle, "Unable to open PushArmor data")
        XCTAssertEqual(S.dataBrokenTitle, "This device's data has become unusable.")
        XCTAssertEqual(S.dataBrokenBody, "Tap Retry to try again. If this keeps happening, you can reset this device. You will then log in again and pair all your devices again.")
        XCTAssertEqual(S.dataBrokenConfirmTitle, "Reset this device?")
        XCTAssertEqual(S.deviceReset, "This device was reset. Log in to start again.")
        XCTAssertEqual(S.pushRegistrationFailed,
                       "Unable to turn on notifications.\nApple's notification service could not be reached. Check your internet connection and try again.")
        XCTAssertEqual(S.loginFailed,
                       "Unable to log in with Google.\nGoogle login is not available in this version. Update PushArmor.")
        XCTAssertEqual(S.updateRequired, "Update PushArmor to continue.")
        XCTAssertEqual(S.approved("Ndev"), "\"Ndev\" confirmed this device.")
        XCTAssertEqual(S.loggedOutNotice("Ndev"), "\"Ndev\" logged out.")
        XCTAssertEqual(S.loggedInNotice("Ndev"), "\"Ndev\" logged in.")
    }

    /// device names are always in straight double quotes; "A device" (no known name) is not.
    func testDeviceNamesAreQuoted() {
        XCTAssertEqual(S.loggedOutNotice(S.aPeer), "A device logged out.")
        XCTAssertEqual(S.denied("Ndev"), "\"Ndev\" rejected this device")
        XCTAssertEqual(S.renamed("Old", "New"), "\"Old\" renamed to \"New\"")
        XCTAssertEqual(S.pairCrossing("Ndev"), "Pairing with \"Ndev\" in progress. Open PushArmor.")
        XCTAssertEqual(S.declinedBy("Ndev"), "Rejected by \"Ndev\"")
        XCTAssertEqual(S.notPairedOn("Ndev"), "Not paired on \"Ndev\"")
        XCTAssertEqual(S.waiting("Ndev"), "Waiting for \"Ndev\": open PushArmor there and tap Codes match.")
        XCTAssertEqual(S.noReplyYet("Ndev"), "No reply yet. Open PushArmor on \"Ndev\", or tap Send again.")
        XCTAssertEqual(S.stillHolds("Ndev"),
                       "\"Ndev\" still holds an earlier pairing. On \"Ndev\", tap Cancel pairing request, then tap Send again.")
        XCTAssertEqual(S.removeConfirm("Ndev"),
                       "Remove \"Ndev\" from this account? \"Ndev\" must log in again and pair with every device again.")
        XCTAssertEqual(S.newMessageFrom(S.aPeer), "New message from A device")
    }

    /// the share sheet says what failed and why on two lines.
    func testShareTexts() {
        XCTAssertEqual(S.shareLoggedOut, "Unable to send.\nThis device is logged out. Open PushArmor and log in.")
        XCTAssertEqual(S.shareNothing, "Unable to send.\nThere is no text or URL to send.")
        XCTAssertEqual(S.shareNoPeers, "Unable to send.\nThis device is not paired with any devices yet. Open PushArmor to pair.")
        // the data or keys failing to open is not a log out
        XCTAssertEqual(S.shareDataFailed(DBError.sql(11, "database disk image is malformed")),
                       "Unable to send.\nPushArmor could not save its data on this device. Restart PushArmor and try again.")
        XCTAssertEqual(S.shareDataFailed(DBError.sql(13, "database or disk is full")),
                       "Unable to send.\nStorage is full. Free some space and try again.")
        XCTAssertEqual(S.shareKeysUnusable,
                       "Unable to send.\nThis device's security keys cannot be used right now. Restart the device and try again.")
    }

    func testWaitTextBoundaries() {
        XCTAssertEqual(S.wait(ms: 500), "1 second")
        XCTAssertEqual(S.wait(ms: 1_000), "1 second")
        XCTAssertEqual(S.wait(ms: 42_000), "42 seconds")
        XCTAssertEqual(S.wait(ms: 60_000), "60 seconds")
        XCTAssertEqual(S.wait(ms: 61_000), "2 minutes")
        XCTAssertEqual(S.wait(ms: 120_000), "2 minutes")
        XCTAssertEqual(S.wait(ms: 121_000), "3 minutes")
        XCTAssertEqual(S.sendLabel("Send code", leftMs: 0), "Send code")
        XCTAssertEqual(S.sendLabel("Send code", leftMs: 42_000), "Send code in 42 seconds")
    }

    func testSendWaitsOnlyForTheAddressJustSentTo() {
        let g = ResendGate(sentTo: "sam@example.com", untilMs: 1_060_000)
        XCTAssertEqual(g.leftMs(for: " Sam@Example.com ", nowMs: 1_018_000), 42_000)
        XCTAssertEqual(g.leftMs(for: "sam@example.com", nowMs: 1_060_000), 0)
        XCTAssertEqual(g.leftMs(for: "other@example.com", nowMs: 1_018_000), 0)
        XCTAssertEqual(ResendGate().leftMs(for: "sam@example.com", nowMs: 1_018_000), 0)
    }
}
