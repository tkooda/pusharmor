import XCTest
import PushArmorCore
@testable import PushArmor

/// A same name adds the device ID only when the clash shows in that place: send targets, the
/// Devices screen, and toasts count the devices the Devices screen lists; History rows count
/// the devices in History.
@MainActor
final class NameClashTests: XCTestCase {
    func testClashOnlyAmongDevicesShownThere() throws {
        let store = try Store(path: NSTemporaryDirectory() + "pa-names-\(UUID().uuidString).sqlite")
        func add(_ b: UInt8, _ name: String, _ state: String) throws -> PeerId {
            let id = try XCTUnwrap(PeerId(raw: Data([0x10] + [UInt8](repeating: b, count: 29))))
            try store.db.exec("""
                INSERT INTO peers (id, state, listed, reachable, platform, created, name, name_n)
                VALUES (?, ?, 1, 1, 'android', ?, ?, 1)
                """, [.text(id.text), .text(state), .int(Int64(b)), .text(name)])
            return id
        }
        let a = try add(1, "Pixel 8", "approved"), gone = try add(2, "pixel 8", "removed")
        _ = try add(3, "PIXEL 8", "denied")
        let model = AppModel()
        model.peers = try store.peers()
        let pa = try XCTUnwrap(model.peers.first { $0.id.text == a.text })
        let clash = "Pixel 8 (" + Ids.deviceId(a.raw) + ")"
        XCTAssertEqual(model.label(pa), "Pixel 8")             // removed with no History rows, rejected: not listed
        XCTAssertEqual(model.historyLabel(pa), "Pixel 8")
        try store.addMessage(dir: .incoming, peer: gone, type: "text", content: "1", n: 1, pairingId: nil, read: false, results: nil, now: 1)
        model.history = try store.history()
        XCTAssertEqual(model.label(pa), clash)                 // the removed one shows while it has History rows
        XCTAssertEqual(model.historyLabel(pa), clash)
        _ = try add(4, "Pixel 8", "approved")
        try store.db.exec("DELETE FROM history")
        model.peers = try store.peers()
        model.history = try store.history()
        XCTAssertEqual(model.label(pa), clash)
        XCTAssertEqual(model.historyLabel(pa), "Pixel 8")      // the other one is not in History
    }

    func testHistoryRowsUseHistoryNames() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/HistoryView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("let l = model.historyLabel(p)"))
        XCTAssertTrue(src.contains(".map { model.historyLabel($0) }"))
        XCTAssertTrue(src.contains("return model.historyLabel(p)"))
        XCTAssertFalse(src.contains("model.label("))
    }
}
