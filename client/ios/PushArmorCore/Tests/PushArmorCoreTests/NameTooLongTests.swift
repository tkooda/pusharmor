import XCTest
@testable import PushArmorCore

/// A typed name over 32 characters (setup and rename) says "Name too long" and the next step,
/// on two lines, instead of "Invalid characters".
final class NameTooLongTests: XCTestCase {
    func testOver32CharactersIsTooLong() {
        let long = String(repeating: "a", count: 33)
        XCTAssertEqual(DeviceName.checkInput(long).error, "Name too long\nUse 32 characters or fewer")
        XCTAssertNil(DeviceName.checkInput(long).name)
        XCTAssertEqual(DeviceName.inputError(long), "Name too long\nUse 32 characters or fewer")
        XCTAssertEqual(ErrorCopy.renameFailText(long, .success(.network)), "Name too long\nUse 32 characters or fewer")
        // too long wins over bad characters
        XCTAssertEqual(DeviceName.checkInput(String(repeating: "!", count: 40)).error, DeviceName.tooLong)
    }

    func testOtherNamesAreUnchanged() {
        let ok = String(repeating: "a", count: 32)
        XCTAssertEqual(DeviceName.checkInput(ok).name, ok)
        XCTAssertEqual(DeviceName.checkInput("  " + ok + "  ").name, ok)
        XCTAssertEqual(DeviceName.checkInput("a!b").error, "Invalid characters")
        XCTAssertEqual(DeviceName.checkInput("").error, "Name too short")
    }

    func testTooLongIsAToastWithNoPeriod() {
        XCTAssertFalse(DeviceName.tooLong.split(separator: "\n").contains { $0.hasSuffix(".") })
        XCTAssertEqual(DeviceName.tooLong.split(separator: "\n").count, 2)
    }
}
