import XCTest
import PushArmorCore
@testable import PushArmor

private final class RecordingHooks: PlatformHooks {
    var calls: [String] = []
    func wipeKeys() { calls.append("keys") }
    func removeLockedInbox() { calls.append("inbox") }
    func removeDeliveredNotifications() { calls.append("delivered") }
    func isProtectedDataLocked() -> Bool { false }
}

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

    /// Reset clears the locked inbox and the delivered notifications, as Delete broken keys
    /// does; the keys are left to the reset's own confirmed DELETE.
    func testResetClearsTheLockedInboxAndDeliveredNotifications() throws {
        let hooks = RecordingHooks()
        AppModel.clearAfterReset(hooks: hooks)
        XCTAssertEqual(hooks.calls, ["inbox", "delivered"])
        let src = try source("App/AppModel.swift")
        let call = try NSRegularExpression(
            pattern: #"store = try await env\.resetStore\(\)\s*AppModel\.clearAfterReset\(hooks: env\)"#)
        XCTAssertEqual(call.numberOfMatches(in: src, range: NSRange(src.startIndex..., in: src)), 1)
    }
}
