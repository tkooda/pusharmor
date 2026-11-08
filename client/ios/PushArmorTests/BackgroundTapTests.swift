import XCTest
import PushArmorCore
@testable import PushArmor

/// Notification taps, the permission explainer, and the pairing notice key.
@MainActor
final class BackgroundTapTests: XCTestCase {
    /// A row the NSE wrote while the app was in the background is not in the in-memory
    /// history yet; a tap (open, or Copy) still finds it in the store.
    func testTapFindsARowNotYetInHistory() throws {
        let store = try ScreenshotSample.makeStore()
        let peer = try XCTUnwrap(PeerId(raw: Data([0x20] + [UInt8](repeating: 0, count: 29))))
        let model = AppModel()
        XCTAssertTrue(model.history.isEmpty)
        let id = try store.addMessage(dir: .incoming, peer: peer, type: "url", content: "https://example.com/a", n: 1,
                                      pairingId: nil, read: false, results: nil, now: Int64(Date().timeIntervalSince1970))
        let row = try XCTUnwrap(AppModel.tapRow(id, store: store))
        XCTAssertEqual(row.content, "https://example.com/a")
        XCTAssertNil(AppModel.tapRow(id + 1000, store: store))
        XCTAssertNil(AppModel.tapRow(nil, store: store))
    }

    /// No account and notifications off: the explainer. It routes again on each foreground,
    /// so turning notifications on in Settings goes on to the log-in screen.
    func testExplainerRoutesAgainOnForeground() throws {
        let store = try ScreenshotSample.makeStore()
        try store.setMe("id", .null)
        let none = try store.me()
        XCTAssertTrue(AppModel.welcomes(notificationsOff: true, me: none))
        XCTAssertFalse(AppModel.welcomes(notificationsOff: false, me: none))
        XCTAssertTrue(AppModel.reroutesOnForeground(.welcome))
        XCTAssertFalse(AppModel.reroutesOnForeground(.main))
        XCTAssertFalse(AppModel.reroutesOnForeground(.signIn(.register)))
    }

    /// Denied: the explainer says plainly why notifications are needed.
    func testExplainerTextWhenDenied() {
        XCTAssertTrue(WelcomeText.text(undecided: false).hasSuffix(
            "PushArmor needs notifications to receive messages. Turn on notifications for PushArmor in Settings."))
        XCTAssertTrue(WelcomeText.text(undecided: true).hasSuffix("Allow notifications so this device can receive them."))
    }

    /// The relay server collapses both pairing notices under pk(N, X): X removes pk(peer, me).
    func testPairingNoticeKeyFollowsRole() throws {
        let me = try XCTUnwrap(PeerId(raw: Data([0x30] + [UInt8](repeating: 0, count: 29))))
        let peer = try XCTUnwrap(PeerId(raw: Data([0x40] + [UInt8](repeating: 0, count: 29))))
        XCTAssertEqual(AppModel.pairingNoticeKey(me: me, peer: peer, role: .n), PairingCrypto.pairingKey(nId: me, xId: peer))
        XCTAssertEqual(AppModel.pairingNoticeKey(me: me, peer: peer, role: .x), PairingCrypto.pairingKey(nId: peer, xId: me))
    }
}
