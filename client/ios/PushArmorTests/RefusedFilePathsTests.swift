import XCTest

/// The Send screen and the share sheet refuse a file before any send try with a toast (or the
/// share sheet's error) only: they add no History item themselves.
final class RefusedFilePathsTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testRefusalsShowOnlyTheError() throws {
        let compose = try source("App/Views/ComposeView.swift")
        XCTAssertTrue(compose.contains("guard Int64(size) <= FileRules.maxFile else {\n            model.toast = FileUi.tooLarge(name)"))
        let share = try source("Share/ShareViewController.swift")
        XCTAssertTrue(share.contains("return .failure(.tooLarge(name))"))
        XCTAssertTrue(share.contains("return .failure(.unreadable(name))"))
        let model = try source("App/FileModel.swift")
        XCTAssertTrue(model.contains("case .tooLarge?: toast = FileUi.tooLarge(name)"))
        for src in [compose, share, model] {
            XCTAssertFalse(src.contains("addMessage("))
        }
    }
}
