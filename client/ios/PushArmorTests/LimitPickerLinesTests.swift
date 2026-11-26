import XCTest

/// Device limit rows: platform, ID, Added date, the Trusts line, then Unreachable and Logged out
/// each on its own line.
final class LimitPickerLinesTests: XCTestCase {
    func testRowLinesInOrder() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/LimitPickerView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        let order = ["Text(PeerLabel.platformName(e.platform))", "Text(\"ID: \" + Ids.deviceId(id.raw))",
                     "Text(\"Added: \" + PeerLabel.addedDate(e.created))", "Text(S.trusts(e.approves, trustedBy: e.approvedBy))",
                     "Text(S.unreachable)", "Text(S.loggedOutBadge)"]
        var at = src.startIndex
        for s in order {
            let r = try XCTUnwrap(src.range(of: s, range: at..<src.endIndex), s)
            at = r.upperBound
        }
        XCTAssertFalse(src.contains("Created"))
    }
}
