import XCTest
import PushArmorCore
@testable import PushArmor

/// A same name adds the device ID: a paired device only for another paired device; a device
/// not paired for a paired device or another device listed in that place (the Devices list for
/// send targets, the Devices screen, and toasts; History for History rows).
@MainActor
final class NameClashTests: XCTestCase {
    func testPairedClashOnlyWithPaired() throws {
        let store = try Store(path: NSTemporaryDirectory() + "pa-names-\(UUID().uuidString).sqlite")
        func add(_ b: UInt8, _ name: String, _ state: String, pinned: Bool) throws -> PeerId {
            let id = try XCTUnwrap(PeerId(raw: Data([0x10] + [UInt8](repeating: b, count: 29))))
            let key: SQLValue = pinned ? .blob(Data([b])) : .null
            try store.db.exec("""
                INSERT INTO peers (id, sign_pub, enc_pub, pairing_id, state, listed, reachable, platform, created, name, name_n)
                VALUES (?, ?, ?, ?, ?, 1, 1, 'android', ?, ?, 1)
                """, [.text(id.text), key, key, key, .text(state), .int(Int64(b)), .text(name)])
            return id
        }
        let a = try add(1, "Pixel 8", "approved", pinned: true), gone = try add(2, "pixel 8", "removed", pinned: true)
        let rej = try add(3, "PIXEL 8", "denied", pinned: false), tab = try add(5, "Tablet", "approved", pinned: true)
        let model = AppModel()
        func peer(_ id: PeerId) throws -> Peer { try XCTUnwrap(model.peers.first { $0.id.text == id.text }) }
        func suffixed(_ id: PeerId, _ name: String) -> String { name + " (" + Ids.deviceId(id.raw) + ")" }
        model.peers = try store.peers()
        XCTAssertEqual(model.label(try peer(a)), "Pixel 8")                    // paired vs rejected, removed
        XCTAssertEqual(model.label(try peer(rej)), suffixed(rej, "PIXEL 8"))  // only the rejected one
        XCTAssertEqual(model.label(try peer(tab)), "Tablet")                  // no clash
        try store.addMessage(dir: .incoming, peer: gone, type: "text", content: "1", n: 1, pairingId: nil, read: false, results: nil, now: 1)
        model.history = try store.history()
        XCTAssertEqual(model.historyLabel(try peer(a)), "Pixel 8")                   // paired vs removed in History
        XCTAssertEqual(model.historyLabel(try peer(gone)), suffixed(gone, "pixel 8"))  // only the removed one
        XCTAssertEqual(model.label(try peer(a)), "Pixel 8")
        let b = try add(4, "Pixel 8", "approved", pinned: true)                      // paired vs paired, not in History
        model.peers = try store.peers()
        XCTAssertEqual(model.label(try peer(a)), suffixed(a, "Pixel 8"))
        XCTAssertEqual(model.label(try peer(b)), suffixed(b, "Pixel 8"))
        XCTAssertEqual(model.historyLabel(try peer(a)), suffixed(a, "Pixel 8"))
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

    /// The send chips, the Send button, and the History "Sent to" line shorten only the name,
    /// never the device ID after it.
    func testNamesShortenBeforeTheirId() throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let compose = try String(contentsOf: dir.appendingPathComponent("App/Views/ComposeView.swift"), encoding: .utf8)
        XCTAssertTrue(compose.contains("let cut = PeerLabel.idSplit(name)\n                        HStack(spacing: 0) {\n                            Text(\"Send to \\\"\").fixedSize()\n                            Text(cut.name).lineLimit(1).truncationMode(.tail)\n                            Text(cut.id + \"\\\"\").fixedSize()"))
        XCTAssertTrue(compose.contains("let cut = PeerLabel.idSplit(title)"))
        XCTAssertTrue(compose.contains("if !cut.id.isEmpty { Text(cut.id).fixedSize() }"))
        let history = try String(contentsOf: dir.appendingPathComponent("App/Views/HistoryView.swift"), encoding: .utf8)
        XCTAssertTrue(history.contains("let cut = PeerLabel.idSplit(name)\n                        HStack(spacing: 0) {\n                            Text(\"Sent to \\\"\").fixedSize()\n                            Text(cut.name).lineLimit(typeSize.isAccessibilitySize ? 2 : 1).truncationMode(.tail)\n                            Text(cut.id + \"\\\"\").fixedSize()"))
    }
}
