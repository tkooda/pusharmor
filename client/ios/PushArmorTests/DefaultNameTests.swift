import XCTest
@testable import PushArmor

/// A new setup offers "iPhone" or "iPad" (by device type) as this device's name.
final class DefaultNameTests: XCTestCase {
    func testNameByDeviceType() {
        XCTAssertEqual(NameDeviceView.defaultName(pad: false, taken: []), "iPhone")
        XCTAssertEqual(NameDeviceView.defaultName(pad: true, taken: []), "iPad")
    }

    func testNameTakenOnTheAccountGetsANumber() {
        XCTAssertEqual(NameDeviceView.defaultName(pad: false, taken: ["iphone"]), "iPhone (2)")
        XCTAssertEqual(NameDeviceView.defaultName(pad: true, taken: ["iPad", "iPad (2)"]), "iPad (3)")
    }

    /// Only the setup screen (shown while this device has no name) fills it; a rename never does.
    func testOnlyAnEmptySetupFieldIsFilled() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/NameDeviceView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("if name.isEmpty {\n                name = Self.defaultName(pad: UIDevice.current.userInterfaceIdiom == .pad"))
    }
}
