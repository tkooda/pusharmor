import XCTest

/// Settings: the Files section sits directly above the History section.
final class SettingsOrderTests: XCTestCase {
    func testFilesSitsDirectlyAboveHistory() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/SettingsView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("FileSettingsSection()\n\n                Section(\"History\") {"))
        let notifications = try XCTUnwrap(src.range(of: "Section(\"Notifications\")"))
        let files = try XCTUnwrap(src.range(of: "FileSettingsSection()"))
        XCTAssertLessThan(notifications.lowerBound, files.lowerBound)
    }
}
