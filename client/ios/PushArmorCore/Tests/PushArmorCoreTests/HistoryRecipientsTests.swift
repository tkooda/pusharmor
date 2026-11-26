import XCTest
@testable import PushArmorCore

/// The Recipients list of a History item: only for a send to two or more devices, one line
/// per device, "Sent" or "Failed".
final class HistoryRecipientsTests: XCTestCase {
    private let names = ["a": "Pixel 8", "b": "Laptop", "c": "iPad (123-456-789)"]

    func testOneDeviceHasNoList() {
        XCTAssertEqual(HistoryRecipients.lines(["a": "sent"]) { self.names[$0]! }, [])
        XCTAssertEqual(HistoryRecipients.lines([:]) { self.names[$0]! }, [])
    }

    func testEachDeviceSentOrFailedByName() {
        let got = HistoryRecipients.lines(["a": "sent", "b": "logged out", "c": "sent"]) { self.names[$0]! }
        XCTAssertEqual(got, [
            HistoryRecipients.Line(name: "iPad (123-456-789)", status: "Sent"),
            HistoryRecipients.Line(name: "Laptop", status: "Failed"),
            HistoryRecipients.Line(name: "Pixel 8", status: "Sent"),
        ])
    }

    func testTitle() {
        XCTAssertEqual(HistoryRecipients.title, "Recipients")
    }
}
