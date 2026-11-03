import XCTest

/// The share sheet is an extension target, so these read its source.
final class ShareSheetTests: XCTestCase {
    private func source() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Share/ShareViewController.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Data or keys that fail to open say so; only a real log out says logged out.
    func testOpenFailuresAreNotALogOut() throws {
        let src = try source()
        XCTAssertTrue(src.contains("step = .failed(S.shareDataFailed(error))"))
        XCTAssertTrue(src.contains("guard let keys = try? env.keychain.load() else {\n            step = .failed(S.shareKeysUnusable)"))
        XCTAssertTrue(src.contains("guard me.id != nil, !me.loggedOut, !me.removed else {\n            step = .failed(S.shareLoggedOut)"))
        XCTAssertEqual(src.components(separatedBy: "S.shareLoggedOut").count - 1, 1)
    }
}
