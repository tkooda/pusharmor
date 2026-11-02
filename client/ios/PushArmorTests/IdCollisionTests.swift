import XCTest
import PushArmorCore
@testable import PushArmor

private struct CreateFailed: Error {}

/// a 409 id collision makes new keys for a fresh login; the old ticket is never sent again.
@MainActor
final class IdCollisionTests: XCTestCase {
    func testNewKeysAndLogInAgain() throws {
        var steps: [String] = []
        let fresh = DeviceKeys(signer: SoftwareSigner(), decryptor: SoftwareDecryptor())
        let next = AppModel.afterIdCollision(deleteKeys: { steps.append("delete") },
                                             createKeys: { steps.append("create"); return fresh })
        XCTAssertEqual(steps, ["delete", "create"])
        let keys = try XCTUnwrap(next.keys)
        XCTAssertEqual(keys.signer.publicKey, fresh.signer.publicKey)
        XCTAssertEqual(next.toast, "Unable to log in.\nLog in again.")
        XCTAssertNotEqual(next.toast, S.loginFailed)
    }

    func testFailedCreateLeavesNoKeys() {
        let next = AppModel.afterIdCollision(deleteKeys: {}, createKeys: { throw CreateFailed() })
        XCTAssertNil(next.keys)
        XCTAssertEqual(next.toast, ErrorCopy.text(.login, .keysUnusable))
    }
}
