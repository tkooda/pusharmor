import XCTest

/// Devices: a collapsed Rejected devices section at the bottom of the list, each row with Pair.
final class RejectedSectionTests: XCTestCase {
    func testRejectedSectionIsAtTheBottomAndCollapsed() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/PeersView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("@State private var rejectedOpen = false"))
        XCTAssertTrue(src.contains("Label(\"Pair a new device\", systemImage: \"plus.circle\")\n                        }\n                    }\n                    RejectedSection(isExpanded: $rejectedOpen)\n                }"))
        XCTAssertTrue(src.contains("DisclosureGroup(\"Rejected devices (\\(rejected.count))\", isExpanded: $isExpanded)"))
        XCTAssertTrue(src.contains("Button(\"Pair\") { Task { await model.pair(p) } }"))
    }
}
