import XCTest
import PushArmorCore
@testable import PushArmor

/// the Send draft is kept in the store, so it survives a kill, and it goes with the wipe.
@MainActor
final class DraftStorageTests: XCTestCase {
    func testDraftIsKeptInTheStoreAndGoesWithTheWipe() throws {
        let store = try ScreenshotSample.makeStore()
        XCTAssertEqual(AppModel.loadDraft(store), "")
        AppModel.saveDraft("hello\nthere", to: store)
        XCTAssertEqual(AppModel.loadDraft(store), "hello\nthere")
        AppModel.saveDraft("", to: store)
        XCTAssertNil(try store.setting(SettingKey.sendDraft))
        AppModel.saveDraft("again", to: store)
        try store.wipe()
        XCTAssertEqual(AppModel.loadDraft(store), "")
        AppModel.saveDraft("late", to: store)   // a write after the wipe keeps nothing
        XCTAssertEqual(AppModel.loadDraft(store), "")
    }

    func testTypedTextShowsBeforeTheWrite() {
        let model = AppModel()
        model.setDraft("abc")
        XCTAssertEqual(model.draft, "abc")
        model.saveDraft()
        XCTAssertEqual(model.draft, "")   // no store here: nothing was kept
    }
}
