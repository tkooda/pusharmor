import XCTest
import PushArmorCore
@testable import PushArmor

/// keys of a register that may have reached the relay server survive a kill; the next
/// register uses them again.
@MainActor
final class RegisterKeysTests: XCTestCase {
    func testKeptWhileTheRegisterMayHaveLanded() {
        XCTAssertTrue(AppModel.keepsRegisterKeys(.network))
        XCTAssertTrue(AppModel.keepsRegisterKeys(.peerLimit(ticket: "t", peers: [])))
        XCTAssertTrue(AppModel.keepsRegisterKeys(.failed(503, nil)))
        // the relay server answered 200 but the store did not save it
        XCTAssertTrue(AppModel.keepsRegisterKeys(.failed(200, "store")))
    }

    func testClearedOnAnAnswer() {
        let id = PeerId(raw: Data([0x10] + [UInt8](repeating: 0, count: 29)))!
        XCTAssertFalse(AppModel.keepsRegisterKeys(.registered(id)))
        XCTAssertFalse(AppModel.keepsRegisterKeys(.idCollision))
        XCTAssertFalse(AppModel.keepsRegisterKeys(.banned))
        XCTAssertFalse(AppModel.keepsRegisterKeys(.ticketExpired))
        XCTAssertFalse(AppModel.keepsRegisterKeys(.failed(400, "bad request")))
    }
}
