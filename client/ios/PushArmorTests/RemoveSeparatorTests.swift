import XCTest

/// The device card menu: one stock separator sets the device actions apart from the switches.
/// It sits directly above "Remove device from account", or on a missing device directly above
/// "Delete", with Delete and Remove together under it.
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
        // missing: the separator, Delete, then Remove with no separator between them
        XCTAssertEqual(Array(lines[(open + 1)..<close]), ["Button(\"Delete\") { confirmDelete = true }"])
        XCTAssertEqual(lines.filter { $0 == "Divider()" }.count, 1)
    }
}
