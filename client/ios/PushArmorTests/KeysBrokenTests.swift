import XCTest
import PushArmorCore
@testable import PushArmor

private final class RecordingHooks: PlatformHooks {
    var calls: [String] = []
    func wipeKeys() { calls.append("keys") }
    func removeLockedInbox() { calls.append("inbox") }
    func removeDeliveredNotifications() { calls.append("delivered") }
    func isProtectedDataLocked() -> Bool { false }
}

/// keys that fail the launch check show their own screen; nothing is deleted until the
/// user confirms Delete broken keys.
@MainActor
final class KeysBrokenTests: XCTestCase {
    func testOnlyUnusableKeysShowTheScreen() {
        XCTAssertEqual(AppModel.phase(for: .unusable), .keysBroken)
        // a passing fault shows the loading screen, so no sign-in can start without keys
        XCTAssertEqual(AppModel.phase(for: .retryLater), .loading)
    }

    func testDeleteGoesToSignInAndKeepsTheOldId() throws {
        let store = try ScreenshotSample.makeStore()
        let id = try XCTUnwrap(store.me().id)
        try store.setSetting(KeyBootstrap.registerKeysSetting, "1")
        let hooks = RecordingHooks()
        XCTAssertEqual(try AppModel.deleteBrokenKeys(store: store, hooks: hooks), .signIn(.register))
        XCTAssertNil(try store.setting(KeyBootstrap.registerKeysSetting))
        let me = try store.me()
        XCTAssertTrue(me.removed)
        XCTAssertEqual(me.oldId, id.text)
        XCTAssertEqual(hooks.calls, ["keys", "inbox", "delivered"])
    }

    func testFailedDeleteKeepsTheKeys() throws {
        let store = try ScreenshotSample.makeStore()
        try store.db.exec("CREATE TEMP TRIGGER fail_wipe BEFORE UPDATE ON me BEGIN SELECT RAISE(ABORT, 'disk full'); END")
        let hooks = RecordingHooks()
        XCTAssertThrowsError(try AppModel.deleteBrokenKeys(store: store, hooks: hooks))
        XCTAssertEqual(hooks.calls, [])
        XCTAssertFalse(try store.me().removed)
    }
}
