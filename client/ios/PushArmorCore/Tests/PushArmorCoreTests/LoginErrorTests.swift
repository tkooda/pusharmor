import XCTest
@testable import PushArmorCore

/// I506: a failed login says why when the relay server or the network gives a cause.
final class LoginErrorTests: XCTestCase {
    func testLoginErrorGivesTheCause() {
        XCTAssertEqual(S.loginError(.network), S.noConnection)
        XCTAssertEqual(S.loginError(.badEmail), S.badEmail)
        XCTAssertEqual(S.loginError(.emailSendFailed), S.emailSendFailed)
        XCTAssertEqual(S.loginError(.rateLimited(30)), "Too many requests. Try again in 30 seconds.")
        XCTAssertEqual(S.loginError(.rateLimited(1)), "Too many requests. Try again in 1 second.")
        XCTAssertEqual(S.loginError(.rateLimited(61)), "Too many requests. Try again in 2 minutes.")
        XCTAssertEqual(S.loginError(.rateLimited(60)), "Too many requests. Try again in 60 seconds.")
        XCTAssertEqual(S.loginError(.failed(401, "wrong code")), S.wrongCode)
        XCTAssertEqual(S.loginError(.failed(401, "code expired")), S.codeExpired)
        XCTAssertEqual(S.loginError(.failed(500, nil)), "Login failed.")
        XCTAssertTrue(S.pushRegistrationFailed.hasSuffix("."))
        XCTAssertEqual(S.updateRequired, "Update PushArmor to continue.")
        XCTAssertEqual(S.approved("Ndev"), "Ndev approved this device.")
        XCTAssertEqual(S.loggedOutNotice("Ndev"), "Ndev logged out.")
        XCTAssertEqual(S.loggedInNotice("Ndev"), "Ndev logged in.")
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
