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

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: RecipientMemory.defaultsKey)
        super.tearDown()
    }

    /// Sending remembers the recipients (L7).
    @MainActor
    func testSendRemembersRecipients() async {
        UserDefaults.standard.removeObject(forKey: RecipientMemory.defaultsKey)
        let sent = await RecipientMemory.send(["c", "a"]) { true }
        XCTAssertTrue(sent)
        XCTAssertEqual(RecipientMemory.load(), ["a", "c"])
    }

    /// A failed send reports false, so the Send screen keeps the draft.
    @MainActor
    func testFailedSendReportsNotSent() async {
        let sent = await RecipientMemory.send(["a"]) { false }
        XCTAssertFalse(sent)
    }

    /// With no Core nothing is sent, so the draft is kept.
    @MainActor
    func testModelSendWithoutCoreReportsNotSent() async {
        let model = AppModel()
        XCTAssertNil(model.core)
        let sent = await model.send("hi", asText: true, toAll: false, peerIds: ["a"])
        XCTAssertFalse(sent)
    }
}
