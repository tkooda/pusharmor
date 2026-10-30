import XCTest
@testable import PushArmor

/// The Send screen remembers its last recipients (F2).
final class RecipientMemoryTests: XCTestCase {
    private let cands: [(id: String, canReceive: Bool)] = [
        (id: "a", canReceive: true), (id: "b", canReceive: false), (id: "c", canReceive: true),
    ]

    func testKeepsRememberedIdsThatCanReceive() {
        XCTAssertEqual(RecipientMemory.preselect(remembered: ["a", "c"], candidates: cands), ["a", "c"])
    }

    func testDropsGoneAndDisabledIds() {
        XCTAssertEqual(RecipientMemory.preselect(remembered: ["a", "b", "zz"], candidates: cands), ["a"])
    }

    func testNothingRememberedGivesEmptyDefault() {
        XCTAssertTrue(RecipientMemory.preselect(remembered: [], candidates: cands).isEmpty)
    }
}
