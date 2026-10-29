import XCTest

/// App-hosted: Bundle.main is the app, so these read the app's Info.plist (project.yml info).
final class InfoPlistTests: XCTestCase {
    func testDeclaresNonExemptEncryption() {
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "ITSAppUsesNonExemptEncryption") as? Bool, false)
    }
}
