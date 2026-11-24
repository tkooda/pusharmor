import XCTest
import PushArmorCore
@testable import PushArmor

/// Progress that can be measured is a stock determinate bar: counted sign-in and account delete
/// steps, a file decrypt by bytes, and a file send by bytes sent. Nothing slides back and forth.
@MainActor
final class StepProgressTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testCountedStepsAreABar() throws {
        let view = try source("App/Views/SettingsView.swift").components(separatedBy: "struct StepProgressView: View {")[1]
        XCTAssertTrue(view.contains("} else if let done = model.stepDone, model.stepTotal > 1 {"))
        XCTAssertTrue(view.contains("ProgressView(value: Double(done), total: Double(model.stepTotal))\n                    .progressViewStyle(.linear)\n                Text(caption)"))
        XCTAssertTrue(try source("App/Views/CodeEntryView.swift").contains("if let c = model.caption { StepProgressView(caption: c) } else { ProgressView() }"))
        XCTAssertTrue(try source("App/Views/LimitPickerView.swift").contains("StepProgressView(caption: c)"))
    }

    func testSignInStepsAreCounted() throws {
        let src = try source("App/AppModel.swift")
        XCTAssertTrue(src.contains("@Published var caption: String? { didSet { if caption == nil { stepDone = nil } } }"))
        XCTAssertTrue(src.contains("countSteps(purpose == .deleteAccount ? 2 : 3)\n        nextStep(S.stepCheckingCode)"))
        XCTAssertEqual(src.components(separatedBy: "countSteps(purpose == .deleteAccount ? 1 : 2)").count - 1, 2)
        XCTAssertTrue(src.contains("countSteps(2)\n        await register(ticket: t.ticket, evict: Array(limitTicked))"))
        XCTAssertTrue(src.contains("nextStep(removing.isEmpty ? S.stepSettingUp : S.stepRemoving(removing))"))
        XCTAssertTrue(src.contains("nextStep(evict.isEmpty ? S.stepLoadingDevices : S.stepLoggingIn)"))
        XCTAssertTrue(src.contains("nextStep(S.stepSettingUp)"))
        XCTAssertTrue(src.contains("nextStep(S.stepLoadingDevices)"))
        XCTAssertTrue(src.contains("nextStep(S.stepDeletingAccount)"))
        XCTAssertFalse(src.contains("caption = S.stepCheckingCode"))
        XCTAssertFalse(src.contains("caption = S.stepDeletingAccount"))
    }

    func testDecryptIsABarByBytes() throws {
        let src = try source("App/Views/FileViews.swift")
        XCTAssertTrue(src.contains("ProgressView(value: Double(min((model.fileBytes[file.id] ?? 0) * 100 / max(file.size, 1), 99)), total: 100)"))
        for path in ["App/Views/FileViews.swift", "App/Views/SendPopup.swift", "App/Views/PeersView.swift", "Share/ShareViewController.swift"] {
            XCTAssertFalse(try source(path).contains("ProgressView().progressViewStyle(.linear)"), path)
        }
    }

    func testFileSendBarFollowsTheBytesSent() throws {
        let app = try source("App/FileModel.swift")
        XCTAssertTrue(app.contains("sendStep = SendProgress.encrypted + Int(min(b * 75 / total, 75))"))
        XCTAssertTrue(app.contains("if f.state == \"uploaded\" || f.state == \"sending\" { sendStep = 100 }"))
        XCTAssertFalse(app.contains("sendStep = 95"))
        XCTAssertTrue(try source("Share/ShareViewController.swift").contains("SendProgress.encrypted + Int(min(done * 75 / total, 75))"))
    }
}
