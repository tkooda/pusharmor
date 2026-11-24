import XCTest

/// Settings: Delete messages older than offers 1, 7, 14, 30, 90, 180, and 365 days.
final class HistoryDaysTests: XCTestCase {
    func testDayChoices() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/SettingsView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("Array(Set([1, 7, 14, 30, 90, 180, 365, model.historyDays])).sorted()"))
    }
}
