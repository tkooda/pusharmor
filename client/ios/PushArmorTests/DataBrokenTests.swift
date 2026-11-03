import XCTest
import PushArmorCore
@testable import PushArmor

/// The corrupt data screen: Retry and Reset this device never run at once, and the reset
/// shows a spinner while it runs.
@MainActor
final class DataBrokenTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testResetIsDisabledWhileRetryRunsAndShowsASpinner() throws {
        let src = try source("App/Views/RootView.swift")
        let view = src.components(separatedBy: "struct DataBrokenView")[1]
            .components(separatedBy: "struct SettingsGear")[0]
        let reset = try NSRegularExpression(
            pattern: #"Button\("Reset this device", role: \.destructive\) \{ confirmReset = true \}\s*\.buttonStyle\(\.bordered\)\s*\.disabled\(model\.busy\.contains\("open"\)\)"#)
        XCTAssertEqual(reset.numberOfMatches(in: view, range: NSRange(view.startIndex..., in: view)), 1)
        XCTAssertTrue(view.contains(#"if model.busy.contains("reset") { ProgressView() }"#))
    }

    func testResetIsSkippedWhileRetryRuns() async {
        let model = AppModel()
        model.busy.insert("open")
        model.phase = .dataBroken
        await model.resetDevice()
        XCTAssertEqual(model.busy, ["open"])
        XCTAssertFalse(model.repairedNotice)
    }
}
