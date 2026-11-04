import XCTest
@testable import PushArmorCore

final class ToastTextTests: XCTestCase {
    func testCopyResult() {
        XCTAssertEqual(ToastText.copied, "Copied")
        XCTAssertEqual(ToastText.copyFailed, "Unable to copy\nSelect the text and copy it by hand")
        let ok = ToastText.copyResult("hello", pasteboardHasText: true)
        XCTAssertEqual(ok.text, "Copied")
        XCTAssertTrue(ok.ok)
        for (v, has) in [("", true), (" \n", true), ("hello", false)] {
            let r = ToastText.copyResult(v, pasteboardHasText: has)
            XCTAssertEqual(r.text, ToastText.copyFailed)
            XCTAssertFalse(r.ok)
        }
    }

    func testShownDropsOnlyTheLastPeriodOfEachLine() {
        XCTAssertEqual(ToastText.shown("Unable to send.\nThe relay server is not working right now. Try again later."),
                       "Unable to send\nThe relay server is not working right now. Try again later")
        XCTAssertEqual(ToastText.shown("Working"), "Working")
        XCTAssertEqual(ToastText.shown("Wait..."), "Wait...")
        XCTAssertEqual(ToastText.shown(""), "")
        // the source texts keep their periods for inline text and alerts
        XCTAssertTrue(ErrorCopy.text(.send, .unreachable).hasSuffix("."))
    }

    /// Every banner text, as shown: no line ends with a period.
    func testNoBannerLineEndsWithAPeriod() {
        let actions: [ErrorCopy.Action] = [.send, .sendOne("X"), .refresh, .rename, .pair("X"), .confirm("X"),
                                           .reject("X"), .remove("X"), .evict, .logout, .sendCode, .checkCode, .login,
                                           .loginGoogle, .loginApple, .prepareLogin, .deleteAccount, .deleteHistory,
                                           .changeSetting, .turnOnNotifications]
        let reasons: [ErrorCopy.Reason] = [.unreachable, .serverDown, .rateLimited(waitMs: 60_000), .tooOld, .removed,
                                           .loggedOut, .loginExpired, .badLink, .clockOff, .blocked, .wrongCode,
                                           .codeExpired, .securityCheck, .emailSendFailed, .badEmail, .emailNotVerified,
                                           .notConfirmed(provider: "Google"), .windowClosed, .badReply, .refused, .tooLong,
                                           .notificationsUnavailable, .appleUnreachable, .googleUnavailable, .keysUnusable,
                                           .storageFull, .saveFailed, .pushRejected, .notReady, .unknown]
        var texts = actions.flatMap { a in reasons.map { ErrorCopy.text(a, $0) } }
        texts += ["sent", "gone", "logged out", "not listening", "unapproved", "denied", "unknown", "failed:x", "other"]
            .compactMap { ErrorCopy.sendResultText($0, "X") }
        texts += [ErrorCopy.nameRule, ErrorCopy.Action.login.line + "\nLog in again.", S.loginFailed,
                  S.stillCannotReceive, S.checkWorking, S.messageSentTo("X"), S.messageSentTo(count: 2),
                  S.sentTo(1, 2), ToastText.copied, ToastText.copyFailed]
        for t in texts {
            for line in ToastText.shown(t).split(separator: "\n") {
                XCTAssertFalse(line.hasSuffix("."), String(line))
            }
        }
        XCTAssertFalse(ToastText.copied.hasSuffix("."))
        XCTAssertFalse(ToastText.copyFailed.split(separator: "\n").contains { $0.hasSuffix(".") })
    }
}
