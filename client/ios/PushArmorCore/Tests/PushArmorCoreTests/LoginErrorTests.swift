import XCTest
@testable import PushArmorCore

/// I506: a failed login says why when the relay server or the network gives a cause.
final class LoginErrorTests: XCTestCase {
    func testLoginErrorGivesTheCause() {
        XCTAssertEqual(S.loginError(.network), S.noConnection)
        XCTAssertEqual(S.loginError(.badEmail), S.badEmail)
        XCTAssertEqual(S.loginError(.emailSendFailed), S.emailSendFailed)
        XCTAssertEqual(S.loginError(.rateLimited(30)), "Too many requests. Try again in 30 seconds.")
        XCTAssertEqual(S.loginError(.failed(401, "wrong code")), S.wrongCode)
        XCTAssertEqual(S.loginError(.failed(401, "code expired")), S.codeExpired)
        XCTAssertEqual(S.loginError(.failed(500, nil)), "Login failed.")
        XCTAssertTrue(S.pushRegistrationFailed.hasSuffix("."))
        XCTAssertEqual(S.updateRequired, "Update PushArmor to continue.")
        XCTAssertEqual(S.approved("Ndev"), "Ndev approved this device.")
        XCTAssertEqual(S.loggedOutNotice("Ndev"), "Ndev logged out.")
        XCTAssertEqual(S.loggedInNotice("Ndev"), "Ndev logged in.")
    }
}
