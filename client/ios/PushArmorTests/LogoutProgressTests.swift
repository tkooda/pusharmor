import XCTest
import PushArmorCore
@testable import PushArmor

/// Log out shows a stock determinate bar with its step under it; a device refresh shows a bar
/// by its steps; no "Removing this device" step.
@MainActor
final class LogoutProgressTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testLogoutIsABarWithItsStepUnderIt() throws {
        XCTAssertEqual(AppModel.logoutSteps, 2)
        let src = try source("App/Views/SettingsView.swift")
        let view = src.components(separatedBy: "struct StepProgressView: View {")[1]
        XCTAssertTrue(view.contains("if caption == S.stepLoggingOut, let done = model.logoutDone {"))
        XCTAssertTrue(view.contains("ProgressView(value: Double(done), total: Double(AppModel.logoutSteps))\n                    .progressViewStyle(.linear)\n                Text(caption)"))
        XCTAssertTrue(view.contains("ProgressView(caption)"))
        XCTAssertTrue(src.contains("StepProgressView(caption: c)"))
        XCTAssertTrue(try source("App/Views/SignInView.swift").contains("StepProgressView(caption: c)"))
    }

    func testLogoutSteps() throws {
        let src = try source("App/AppModel.swift")
        let out = src.components(separatedBy: "func signOut() async {")[1].components(separatedBy: "func deleteAccount(")[0]
        XCTAssertTrue(out.contains("caption = S.stepLoggingOut\n        logoutDone = 0"))
        XCTAssertTrue(out.contains("logoutDone = 1\n        await route()"))
        XCTAssertTrue(out.contains("logoutDone = nil\n            if caption == S.stepLoggingOut { caption = nil }"))
        XCTAssertFalse(src.contains("Removing this device"))
        XCTAssertFalse(src.contains("stepRemovingThisDevice"))
    }

    func testRefreshIsABarByItsSteps() throws {
        XCTAssertEqual(Core.refreshSteps, 5)
        let src = try source("App/Views/PeersView.swift")
        XCTAssertTrue(src.contains("ProgressView(value: Double(model.refreshDone), total: Double(Core.refreshSteps))\n                                    .progressViewStyle(.linear)"))
        XCTAssertTrue(src.contains("Text(S.stepUpdatingDevices)"))
        let model = try source("App/AppModel.swift")
        XCTAssertTrue(model.contains("refreshDone = 0"))
        XCTAssertTrue(model.contains("core.refresh(push: pushInfo, step: { n in await MainActor.run { self.refreshDone = n } })"))
        let core = try source("PushArmorCore/Sources/PushArmorCore/Account.swift")
        for n in 1 ... 5 { XCTAssertTrue(core.contains("await step?(\(n))")) }
    }
}
