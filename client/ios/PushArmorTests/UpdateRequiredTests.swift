import XCTest
import PushArmorCore
@testable import PushArmor

/// Q349: a 426 on any request marks this version, so every launch of it opens on the update
/// screen; a different version clears the mark.
@MainActor
final class UpdateRequiredTests: XCTestCase {
    func test426ShowsTheUpdateScreenUntilTheVersionChanges() {
        let env = AppEnvironment.shared
        env.defaults.removeObject(forKey: UpdateGate.key)
        // UI tests launch this app afterwards: never leave the mark behind
        addTeardownBlock { AppEnvironment.shared.defaults.removeObject(forKey: UpdateGate.key) }
        XCTAssertFalse(AppModel().updateRequired)
        NotificationCenter.default.post(name: APIClient.upgradeRequired, object: nil)
        XCTAssertTrue(env.updateRequired)
        XCTAssertTrue(AppModel().updateRequired) // the next launch
        XCTAssertFalse(UpdateGate.required(env.defaults, version: AppEnvironment.version + ".1"))
        XCTAssertFalse(env.updateRequired)
        XCTAssertFalse(AppModel().updateRequired)
    }
}
