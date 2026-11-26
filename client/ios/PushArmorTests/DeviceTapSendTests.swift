import XCTest
import PushArmorCore
@testable import PushArmor

/// A tap on a paired device in the Devices list opens the Send screen with only that device
/// chosen. That one-off choice is not saved; only a send that goes through saves the choice.
@MainActor
final class DeviceTapSendTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: RecipientMemory.defaultsKey)
        super.tearDown()
    }

    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testPairedDeviceTapPicksOnlyIt() throws {
        let store = try Store(path: NSTemporaryDirectory() + "pa-tap-\(UUID().uuidString).sqlite")
        func add(_ b: UInt8, _ state: String) throws -> PeerId {
            let id = try XCTUnwrap(PeerId(raw: Data([0x10] + [UInt8](repeating: b, count: 29))))
            let key: SQLValue = .blob(Data([b]))
            try store.db.exec("""
                INSERT INTO peers (id, sign_pub, enc_pub, pairing_id, state, listed, reachable, platform, created, name, name_n)
                VALUES (?, ?, ?, ?, ?, 1, 1, 'android', ?, ?, 1)
                """, [.text(id.text), key, key, key, .text(state), .int(Int64(b)), .text("Dev \(b)")])
            return id
        }
        let paired = try add(1, "approved"), gone = try add(2, "removed")
        let model = AppModel()
        model.peers = try store.peers()
        model.openSend(to: try XCTUnwrap(model.peers.first { $0.id.text == gone.text }))
        XCTAssertNil(model.sendTo)
        model.openSend(to: try XCTUnwrap(model.peers.first { $0.id.text == paired.text }))
        XCTAssertEqual(model.sendTo, paired.text)
        XCTAssertNil(UserDefaults.standard.stringArray(forKey: RecipientMemory.defaultsKey))
    }

    func testOnlyASendThatWentThroughSavesTheChoice() async {
        RecipientMemory.save(["a", "b"])
        let failed = await RecipientMemory.send(["c"]) { false }
        XCTAssertFalse(failed)
        XCTAssertEqual(RecipientMemory.load(), ["a", "b"])
        let sent = await RecipientMemory.send(["c"]) { true }
        XCTAssertTrue(sent)
        XCTAssertEqual(RecipientMemory.load(), ["c"])
    }

    func testTheTapOpensSendWithOnlyThatDevice() throws {
        let peers = try source("App/Views/PeersView.swift")
        XCTAssertTrue(peers.contains(".onTapGesture { if greyed { Task { await model.tapGreyed() } } else { model.openSend(to: p) } }"))
        let main = try source("App/Views/MainView.swift")
        XCTAssertTrue(main.contains(".onChange(of: model.sendTo) { _, v in\n            if v != nil { select(0) }"))
        let compose = try source("App/Views/ComposeView.swift")
        let pick = compose.components(separatedBy: "private func takePick()")[1].components(separatedBy: "private var hasRecipient")[0]
        XCTAssertTrue(pick.contains("selected = [id]"))
        XCTAssertTrue(pick.contains("toAll = false"))
        XCTAssertFalse(pick.contains("RecipientMemory.save"))
        XCTAssertTrue(compose.contains(".onAppear {\n            takePick()\n            restoreSelection()\n        }"))
    }
}
