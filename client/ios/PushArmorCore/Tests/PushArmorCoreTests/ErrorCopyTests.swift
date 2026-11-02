import XCTest
@testable import PushArmorCore

/// error texts: action line, then reason line, exact approved words.
final class ErrorCopyTests: XCTestCase {
    func reply(_ status: Int, _ body: String = "{}") -> APIOutcome {
        .reply(APIReply(status: status, body: Data(body.utf8)))
    }

    func testActionLines() {
        let lines: [(ErrorCopy.Action, String)] = [
            (.send, "Unable to send."),
            (.sendOne("Ndev"), "Unable to send to \"Ndev\"."),
            (.refresh, "Unable to refresh the device list."),
            (.rename, "Unable to rename this device."),
            (.pair("Ndev"), "Unable to pair with \"Ndev\"."),
            (.confirm("Ndev"), "Unable to confirm \"Ndev\"."),
            (.reject("Ndev"), "Unable to reject \"Ndev\"."),
            (.remove("Ndev"), "Unable to remove \"Ndev\"."),
            (.evict, "Unable to remove the chosen devices."),
            (.logout, "Unable to log out."),
            (.sendCode, "Unable to send the code."),
            (.checkCode, "Unable to check the code."),
            (.login, "Unable to log in."),
            (.loginGoogle, "Unable to log in with Google."),
            (.loginApple, "Unable to log in with Apple."),
            (.prepareLogin, "Unable to start the login."),
            (.deleteAccount, "Unable to delete the account."),
            (.deleteHistory, "Unable to delete the history."),
            (.changeSetting, "Unable to change this setting."),
            (.turnOnNotifications, "Unable to turn on notifications."),
        ]
        for (a, s) in lines { XCTAssertEqual(a.line, s) }
    }

    func testReasonLines() {
        let lines: [(ErrorCopy.Reason, String)] = [
            (.unreachable, "The relay server could not be reached. Check your internet connection and try again."),
            (.serverDown, "The relay server is not working right now. Try again later."),
            (.rateLimited(waitMs: 30_000), "Too many tries. Try again in 30 seconds."),
            (.rateLimited(waitMs: 61_000), "Too many tries. Try again in 2 minutes."),
            (.tooOld, "This version of PushArmor is too old. Update PushArmor to continue."),
            (.removed, "This device was removed from the account. Log in again."),
            (.loggedOut, "This device is logged out. Log in to resume."),
            (.loginExpired, "The login expired. Log in again."),
            (.badLink, "The login link is not valid. Request a new code and try again."),
            (.clockOff, "This device's clock is off by more than 5 minutes. Fix the clock and try again."),
            (.blocked, "This account is blocked."),
            (.wrongCode, "The code is not correct. Check the newest email from PushArmor and try again."),
            (.codeExpired, "The code expired. Request a new code to continue."),
            (.securityCheck, "The security check did not finish. Try again."),
            (.emailSendFailed, "The relay server could not send the email. Try again."),
            (.badEmail, "Only email addresses with plain ASCII characters are supported."),
            (.emailNotVerified, "This Google account has no verified email address."),
            (.notConfirmed(provider: "Google"), "Google did not confirm the login. Try again."),
            (.notConfirmed(provider: "Apple"), "Apple did not confirm the login. Try again."),
            (.windowClosed, "The login window was closed. Try again."),
            (.badReply, "The relay server sent a reply this device cannot use. Try again."),
            (.refused, "The relay server did not accept the request. Update PushArmor and try again."),
            (.tooLong, "The message is longer than 2048 characters."),
            (.notificationsUnavailable,
             "Notifications are not available on this device. Allow notifications for PushArmor in iOS Settings, then try again."),
            (.keysUnusable, "This device's security keys cannot be used right now. Restart the device and try again."),
            (.storageFull, "Storage is full. Free some space and try again."),
            (.saveFailed, "PushArmor could not save its data on this device. Restart PushArmor and try again."),
            (.pushRejected, "Its push service did not accept the message. Try again later."),
            (.notReady, "It has not finished turning on notifications. Open PushArmor on it."),
            (.unknown, "Try again."),
        ]
        for (r, s) in lines {
            XCTAssertEqual(r.line, s)
            let t = ErrorCopy.text(.rename, r)
            XCTAssertEqual(t, "Unable to rename this device.\n" + s)
            XCTAssertTrue(t.unicodeScalars.allSatisfy { $0.isASCII }, t)
            for l in t.split(separator: "\n") { XCTAssertFalse(l.hasPrefix("\""), t) }
        }
    }

    func testReasonFromReplies() {
        XCTAssertEqual(ErrorCopy.reason(from: nil), .unreachable)
        XCTAssertEqual(ErrorCopy.reason(from: .network), .unreachable)
        XCTAssertEqual(ErrorCopy.reason(from: reply(503)), .serverDown)
        XCTAssertEqual(ErrorCopy.reason(from: reply(500)), .serverDown)
        XCTAssertEqual(ErrorCopy.reason(from: reply(429, "{\"retry_after\":42}")), .rateLimited(waitMs: 42_000))
        XCTAssertEqual(ErrorCopy.reason(from: reply(429)), .rateLimited(waitMs: 60_000))
        XCTAssertEqual(ErrorCopy.reason(from: reply(426)), .tooOld)
        XCTAssertEqual(ErrorCopy.reason(from: reply(413, "{\"error\":\"too large\"}")), .tooLong)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"clock skew\"}")), .clockOff)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"unknown peer\"}")), .removed)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"logged out\"}")), .loggedOut)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"invalid client signature\"}")), .refused)
        XCTAssertEqual(ErrorCopy.reason(from: reply(400, "{\"error\":\"bad request\"}")), .refused)
        XCTAssertEqual(ErrorCopy.reason(from: reply(404)), .refused)
        XCTAssertEqual(ErrorCopy.reason(from: reply(405)), .refused)
        XCTAssertEqual(ErrorCopy.reason(from: reply(200, "x")), .badReply)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"ticket expired\"}")), .loginExpired)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"invalid ticket\"}")), .badLink)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"bad ticket\"}")), .badLink)
        XCTAssertEqual(ErrorCopy.reason(from: reply(403, "{\"error\":\"banned\"}")), .blocked)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"wrong code\"}")), .wrongCode)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"code expired\"}")), .codeExpired)
        XCTAssertEqual(ErrorCopy.reason(from: reply(403, "{\"error\":\"turnstile failed\"}")), .securityCheck)
        XCTAssertEqual(ErrorCopy.reason(from: reply(502, "{\"error\":\"email send failed\"}")), .emailSendFailed)
        XCTAssertEqual(ErrorCopy.reason(from: reply(502)), .serverDown)
        XCTAssertEqual(ErrorCopy.reason(from: reply(400, "{\"error\":\"bad email\"}")), .badEmail)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"email not verified\"}")), .emailNotVerified)
        XCTAssertEqual(ErrorCopy.reason(from: reply(401, "{\"error\":\"invalid id_token\"}"), provider: "Google"),
                       .notConfirmed(provider: "Google"))
        XCTAssertEqual(ErrorCopy.reason(from: reply(409, "{\"error\":\"other\"}")), .unknown)
    }

    /// a failed id check is not a removal: its own retry line, never the removed line.
    func testBadIdIsNotRemoval() {
        let r = ErrorCopy.reason(from: reply(401, "{\"error\":\"bad id\"}"))
        XCTAssertEqual(r, .unknown)
        XCTAssertNotEqual(r, .removed)
        XCTAssertEqual(ErrorCopy.text(.refresh, r), "Unable to refresh the device list.\nTry again.")
    }

    func testLocalErrors() {
        XCTAssertEqual(ErrorCopy.reason(local: DBError.sql(13, "database or disk is full")), .storageFull)
        XCTAssertEqual(ErrorCopy.reason(local: DBError.sql(10, "disk I/O error")), .saveFailed)
        XCTAssertEqual(ErrorCopy.reason(local: DBError.open("x")), .saveFailed)
        XCTAssertEqual(ErrorCopy.reason(local: Core.CoreError.notPinned), .unknown)
    }

    /// a rename shows the name rule only for a bad name; any other failure says why.
    func testRenameFailText() {
        XCTAssertEqual(ErrorCopy.renameFailText("a\"b", .success(.network)), ErrorCopy.nameRule)
        XCTAssertEqual(ErrorCopy.nameRule, "Use 1 to 32 plain ASCII characters, no double quote.")
        XCTAssertNil(ErrorCopy.renameFailText("Ndev", .success(reply(200))))
        XCTAssertEqual(ErrorCopy.renameFailText("Ndev", .success(.network)),
                       "Unable to rename this device.\nThe relay server could not be reached. Check your internet connection and try again.")
        XCTAssertEqual(ErrorCopy.renameFailText("Ndev", .success(reply(503))),
                       "Unable to rename this device.\nThe relay server is not working right now. Try again later.")
        XCTAssertEqual(ErrorCopy.renameFailText("Ndev", .success(.keysUnusable)),
                       "Unable to rename this device.\nThis device's security keys cannot be used right now. Restart the device and try again.")
        XCTAssertEqual(ErrorCopy.renameFailText("Ndev", .failure(Core.CoreError.notPinned)), "Unable to rename this device.\nTry again.")
        XCTAssertEqual(ErrorCopy.renameFailText("Ndev", .failure(DBError.sql(13, "full"))),
                       "Unable to rename this device.\nStorage is full. Free some space and try again.")
    }
}
