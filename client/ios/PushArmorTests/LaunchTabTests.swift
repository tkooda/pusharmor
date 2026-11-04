import XCTest
import PushArmorCore
@testable import PushArmor

/// A plain launch opens Send only when a pairing is complete on both sides, else Devices.
@MainActor
final class LaunchTabTests: XCTestCase {
    func testSendOnlyWhenAPairingIsCompleteOnBothSides() throws {
        let store = try ScreenshotSample.makeStore()
        let model = AppModel()
        try store.db.exec("DELETE FROM peers")
        model.peers = try store.peers()
        XCTAssertFalse(model.launchesOnSend)   // no device

        // this device approved the other; the other has not approved this one yet
        let id = String(repeating: "N", count: 40)
        try store.db.exec("""
            INSERT INTO peers (id, state, listed, reachable, platform, created, name, name_n, sign_pub, enc_pub, pairing_id)
            VALUES (?, 'approved', 1, 1, 'chrome', 1761300000, 'New laptop', 1, ?, ?, ?)
            """, [.text(id), .blob(Data(repeating: 2, count: 65)), .blob(Data(repeating: 3, count: 65)),
                  .blob(Data(repeating: 1, count: 16))])
        model.peers = try store.peers()
        XCTAssertFalse(model.needsFirstPair)
        XCTAssertFalse(model.launchesOnSend)

        // the other device approves this one: the pairing is complete
        try store.db.exec("UPDATE peers SET approve_verified = 1 WHERE id = ?", [.text(id)])
        model.peers = try store.peers()
        XCTAssertTrue(model.launchesOnSend)
    }

    func testMainViewChoosesTheTabByTheCompletePairingRule() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/MainView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("if model.highlightPeer != nil || !model.launchesOnSend { tab = 1 }"))
    }

    func testHistoryTilesDoNotOpenDevices() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/HistoryView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(src.contains("highlightPeer"))
    }
}
