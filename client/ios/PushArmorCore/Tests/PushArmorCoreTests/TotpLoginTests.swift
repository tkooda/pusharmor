import XCTest
@testable import PushArmorCore

/// A TOTP login address skips the security check; any other address still gets it.
final class TotpLoginTests: XCTestCase {
    private let fake: Set<String> = ["57a72913d39ff4c5b84e2dee71d61484737975c6308199293aa6a16666b411dd"] // fake.login@example.com

    func testMatchSkipsCheck() {
        XCTAssertFalse(TotpLogin.needsSecurityCheck("fake.login@example.com", hashes: fake))
        XCTAssertFalse(TotpLogin.needsSecurityCheck(" \tFake.Login@Example.COM\n", hashes: fake))
    }

    func testOtherAddressGetsCheck() {
        XCTAssertTrue(TotpLogin.needsSecurityCheck("other@example.com", hashes: fake))
        XCTAssertTrue(TotpLogin.needsSecurityCheck("fake.login@example.com"))
    }
}
