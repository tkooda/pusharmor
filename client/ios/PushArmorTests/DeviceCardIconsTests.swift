import XCTest

/// Devices list cards: the status icons sit at the right end of the status line (Paired, ...)
/// when they fit, else on their own line under it. The view is SwiftUI layout, so this reads
/// its source.
final class DeviceCardIconsTests: XCTestCase {
    func testIconsEndTheStatusLineOrWrapUnderIt() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/PeersView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        let header = src.components(separatedBy: "private func header(icons: Bool)")[1].components(separatedBy: "struct PeerMenuItems")[0]
        // lines compared without their indent
        let lines = header.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
        XCTAssertTrue(lines.contains([
            "ViewThatFits(in: .horizontal) {",
            "HStack(spacing: 8) {",
            "StatusLine(kind: status.kind, text: status.text)",
            "Spacer(minLength: 0)",
            "statusIcons",
            "}",
            "VStack(alignment: .leading, spacing: 2) {",
            "StatusLine(kind: status.kind, text: status.text)",
            "statusIcons",
            "}",
            "}",
        ].joined(separator: "\n")))
        // the icons no longer span the platform, ID, and Added lines
        XCTAssertFalse(lines.contains("if icons {\nSpacer(minLength: 0)\nstatusIcons"))
    }
}
