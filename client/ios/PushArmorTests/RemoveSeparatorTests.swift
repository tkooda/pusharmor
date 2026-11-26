import XCTest

/// The device card menu: a stock separator sits directly above "Remove device from account",
/// so it is set apart from the switches (and from Delete on a missing device).
final class RemoveSeparatorTests: XCTestCase {
    func testSeparatorDirectlyAboveRemove() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/PeersView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        let menu = src.components(separatedBy: "struct PeerMenuItems")[1]
        // the code lines of the menu, without indent and comments
        let lines = menu.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.hasPrefix("//") }
        let remove = try XCTUnwrap(lines.firstIndex { $0.hasPrefix("Button(\"Remove device from account\"") })
        // not missing: the separator, then Remove
        let close = try XCTUnwrap(lines[..<remove].lastIndex(of: "}"))
        XCTAssertEqual(close, remove - 1)
        let open = try XCTUnwrap(lines[..<close].lastIndex(of: "if p.missing {"))
        XCTAssertEqual(lines[open - 1], "Divider()")
        // missing: Delete, then a separator, then Remove
        XCTAssertEqual(Array(lines[(open + 1)..<close]), ["Button(\"Delete\") { confirmDelete = true }", "Divider()"])
    }
}
