import XCTest
import PushArmorCore
@testable import PushArmor

/// Cancel pairing is offered only when Core can carry it out.
@MainActor
final class CancelPairingTests: XCTestCase {
    func testNoCancelPairingWhenCoreDidNotStart() throws {
        let store = try ScreenshotSample.makeStore()
        let p = try XCTUnwrap(store.peers().first)
        let now = Int64(Date().timeIntervalSince1970)
        try store.db.exec("""
            INSERT INTO pairing (peer_id, role, state, r, authorized, started_at, last_send_at)
            VALUES (?, 'X', 'shown', ?, 1, ?, ?)
            """, [.text(p.id.text), .blob(Data(count: 32)), .int(now), .int(now)])
        let entry = try XCTUnwrap(store.pairings().first)
        let model = AppModel()
        XCTAssertNil(model.core)
        model.pairings = [p.id.text: entry]
        XCTAssertFalse(model.offersCancel(p))
    }
}
