import XCTest
import PushArmorCore
@testable import PushArmor

/// Q338, I612: the first-pair steps show in Devices while no device is paired, list the
/// devices waiting to pair, go once a pairing completes, and come back when the last one is removed.
@MainActor
final class FirstPairTests: XCTestCase {
    func testFirstPairFollowsPairedDevices() throws {
        let store = try ScreenshotSample.makeStore()
        let model = AppModel()
        model.peers = try store.peers()
        XCTAssertFalse(model.needsFirstPair)   // the sample has paired devices

        // zero devices
        try store.db.exec("DELETE FROM peers")
        model.peers = try store.peers()
        XCTAssertTrue(model.needsFirstPair)
        XCTAssertTrue(model.waitingToPair.isEmpty)

        // a device waiting to pair
        let id = String(repeating: "N", count: 40)
        try store.db.exec("""
            INSERT INTO peers (id, state, listed, reachable, platform, created, name, name_n)
            VALUES (?, 'unruled', 1, 1, 'chrome', 1761300000, 'New laptop', 1)
            """, [.text(id)])
        model.peers = try store.peers()
        XCTAssertTrue(model.needsFirstPair)
        XCTAssertEqual(model.waitingToPair.map { $0.id.text }, [id])

        // the pairing completes: the tabs return
        try store.db.exec("UPDATE peers SET state = 'approved', sign_pub = ?, enc_pub = ?, pairing_id = ? WHERE id = ?",
                          [.blob(Data(repeating: 2, count: 65)), .blob(Data(repeating: 3, count: 65)),
                           .blob(Data(repeating: 1, count: 16)), .text(id)])
        model.peers = try store.peers()
        XCTAssertFalse(model.needsFirstPair)
        XCTAssertTrue(model.waitingToPair.isEmpty)

        // the last paired device removed: the first-pair screen again
        try store.db.exec("UPDATE peers SET state = 'removed', sign_pub = NULL, enc_pub = NULL, pairing_id = NULL")
        model.peers = try store.peers()
        XCTAssertTrue(model.needsFirstPair)
        XCTAssertTrue(model.waitingToPair.isEmpty)
    }
}
