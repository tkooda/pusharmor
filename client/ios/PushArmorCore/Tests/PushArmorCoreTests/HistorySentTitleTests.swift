import XCTest
@testable import PushArmorCore

/// The History title of a sent item: a send to two or more devices counts them.
final class HistorySentTitleTests: XCTestCase {
    func testAllReachedSaysHowMany() {
        XCTAssertEqual(S.historySentTo(2, 2), "Sent to 2 devices")
        XCTAssertEqual(S.historySentTo(5, 5), "Sent to 5 devices")
    }

    func testSomeFailedSaysHowManyOfThem() {
        XCTAssertEqual(S.historySentTo(1, 2), "Sent to 1 of 2 devices")
        XCTAssertEqual(S.historySentTo(0, 3), "Sent to 0 of 3 devices")
    }

    func testOneDeviceIsUnchanged() {
        XCTAssertEqual(S.historySentTo(0, 1), "Sent to 0 of 1 device")
        XCTAssertEqual(S.sentToOne("Laptop"), "Sent to \"Laptop\"")
    }
}
