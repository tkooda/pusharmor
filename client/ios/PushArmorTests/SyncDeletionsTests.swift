import XCTest
import PushArmorCore
@testable import PushArmor

/// Sync deletions in the app: a stock Toggle in the History section, default on, and a failed
/// delete keeps the rows and shows the two-line error.
@MainActor
final class SyncDeletionsTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func count(_ pattern: String, in s: String) throws -> Int {
        try NSRegularExpression(pattern: pattern).numberOfMatches(in: s, range: NSRange(s.startIndex..., in: s))
    }

    func testSettingIsAStockToggleDefaultOn() throws {
        let src = try source("App/Views/SettingsView.swift")
        let history = src.components(separatedBy: "Section(\"History\")")[1].components(separatedBy: "Section(\"Account\")")[0]
        XCTAssertEqual(try count(#"Toggle\("Sync deletions", isOn: boolBinding\(SettingKey\.syncDeletions, true\)\)"#, in: history), 1)
        XCTAssertEqual(try count(#"Text\("Deleting on this device will also delete on your other devices\."\)"#, in: history), 1)
        XCTAssertEqual(SettingKey.syncDeletions, "sync_deletions")
    }

    func testFailedDeleteShowsTheError() throws {
        let src = try source("App/AppModel.swift")
        XCTAssertEqual(try count(#"catch \{ toast = ErrorCopy\.deleteFailText\(\.deleteMessages\(ids\.count\), error\) \}"#, in: src), 1)
        XCTAssertEqual(try count(#"toast = ErrorCopy\.deleteFailText\(\.deleteHistory, error\)"#, in: src), 1)
    }
}
