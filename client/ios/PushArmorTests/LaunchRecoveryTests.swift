import XCTest
import PushArmorCore
@testable import PushArmor

/// after a launch error, the next foreground opens the store and loads the keys again.
@MainActor
final class LaunchRecoveryTests: XCTestCase {
    func testReopenAfterLaunchError() throws {
        // the store did not open
        XCTAssertTrue(AppModel.needsReopen(hasStore: false, hasCore: false, me: nil))
        // a signed-in device with no keys loaded
        let store = try ScreenshotSample.makeStore()
        let me = try store.me()
        XCTAssertNotNil(me.id)
        XCTAssertTrue(AppModel.needsReopen(hasStore: true, hasCore: false, me: me))
        // a working launch
        XCTAssertFalse(AppModel.needsReopen(hasStore: true, hasCore: true, me: me))
        // a removed device has no keys on purpose
        try store.wipe()
        XCTAssertFalse(AppModel.needsReopen(hasStore: true, hasCore: false, me: try store.me()))
    }

    func testReopenAfterKeychainFaultWithNoAccount() throws {
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("pa-launch-retry.sqlite")
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) }
        let me = try Store(path: path).me()
        XCTAssertNil(me.id)
        // the launch stopped before it read the old id: the next foreground tries again
        XCTAssertTrue(AppModel.needsReopen(hasStore: true, hasCore: false, me: me, launchRetry: true))
        XCTAssertFalse(AppModel.needsReopen(hasStore: true, hasCore: false, me: me, launchRetry: false))
        XCTAssertFalse(AppModel.needsReopen(hasStore: true, hasCore: true, me: me, launchRetry: true))
    }

    func testLaunchErrorIsPlainText() {
        XCTAssertTrue(S.launchFailed.hasSuffix("."))
        XCTAssertFalse(S.launchFailed.contains("sql"))
    }
}
