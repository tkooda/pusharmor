import XCTest
@testable import PushArmorCore

final class VersionTextTests: XCTestCase {
    func testMake() {
        XCTAssertEqual(VersionText.make("0.0.28"), "Version 0.0.28")
        XCTAssertEqual(VersionText.make(" 1.2.3\n"), "Version 1.2.3")
        XCTAssertEqual(VersionText.make(""), "")
    }

    func testCopyValue() {
        XCTAssertEqual(VersionText.copyValue("0.0.28"), "0.0.28")
        XCTAssertEqual(VersionText.copyValue(" 1.2.3\n"), "1.2.3")
    }
}
