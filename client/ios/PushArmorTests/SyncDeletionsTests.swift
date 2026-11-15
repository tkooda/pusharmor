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
        XCTAssertEqual(try count(#"catch \{ toast = ErrorCopy\.deleteFailText\(\.deleteOnThisDevice, error\) \}"#, in: src), 1)
        XCTAssertEqual(try count(#"toast = ErrorCopy\.deleteFailText\(\.deleteOnThisDevice, error\)"#, in: src), 1)
        XCTAssertEqual(try count(#"if let t = try await core\.deleteHistoryRows\(Array\(ids\), progress: \{ p in"#, in: src), 1)
    }

    /// A row not deleted on every device is struck through with the devices under it; a
    /// delete in several calls shows a determinate bar with its step.
    func testPendingRowAndProgressBar() throws {
        let src = try source("App/Views/HistoryView.swift")
        XCTAssertEqual(try count(#"\.strikethrough\(!notDeletedOn\.isEmpty\)"#, in: src), 1)
        XCTAssertEqual(try count(#"Text\(S\.notDeletedOn\(notDeletedOn\)\)"#, in: src), 1)
        XCTAssertEqual(try count(#"if let p = model\.deleteProgress, p\.total > 1 \{"#, in: src), 1)
        XCTAssertEqual(try count(#"ProgressView\(value: Double\(p\.done\), total: Double\(p\.total\)\)"#, in: src), 1)
    }

    /// An opened message not deleted on every device: its text struck through and the devices
    /// under it, as on its closed row; the row does not repeat the line while open.
    func testPendingDetail() throws {
        let row = try source("App/Views/HistoryView.swift")
        XCTAssertEqual(try count(#"MessageDetailView\(row: row, notDeletedOn: notDeletedOn\)"#, in: row), 1)
        XCTAssertEqual(try count(#"if !isOpen, !notDeletedOn\.isEmpty \{"#, in: row), 1)
        let src = try source("App/Views/MessageDetailView.swift")
        XCTAssertEqual(try count(#"\.strikethrough\(!notDeletedOn\.isEmpty\)"#, in: src), 2)
        XCTAssertEqual(try count(#"Text\(S\.notDeletedOn\(notDeletedOn\)\)"#, in: src), 1)
    }

    /// No delete-all anywhere: History has a select-all checkbox instead.
    func testNoDeleteAll() throws {
        XCTAssertFalse(try source("App/Views/SettingsView.swift").contains("Delete all history"))
        XCTAssertFalse(try source("App/AppModel.swift").contains("deleteAllHistory"))
        XCTAssertTrue(try source("App/Views/HistoryView.swift").contains("selection.toggleAll(shown)"))
    }
}
