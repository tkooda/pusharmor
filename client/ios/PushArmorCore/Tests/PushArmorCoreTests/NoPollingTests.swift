import XCTest
@testable import PushArmorCore

/// No polling: the relay server hears from a device only on a push, a user action, or an open.
final class NoPollingTests: XCTestCase {
    var w: FakeWorker!
    var clock: TestClock!

    override func setUp() {
        w = FakeWorker()
        clock = TestClock()
    }

    func dev(_ name: String) throws -> Device { try Device(worker: w, clock: clock, name: name) }

    /// No polling: after the open, an idle device makes no relay server call however long it waits.
    func testIdleMakesNoRelayCall() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await Scenario.pairFully(w, n, x)
        await n.core.appOpen(push: nil)
        let before = w.calls.count
        clock.now += 600                                                   // 10 minutes with the Devices screen open
        _ = await n.drainInbox(w)                                          // nothing arrived
        XCTAssertEqual(w.calls.count, before)
    }
}
