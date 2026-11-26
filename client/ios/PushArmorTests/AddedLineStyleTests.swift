import XCTest

/// Every "Added: YYYY-MM-DD" line (device cards, pairing cards, the device-limit picker) shows
/// smaller and dimmer than the "ID:" line above it, in the stock caption and secondary styles.
final class AddedLineStyleTests: XCTestCase {
    private func lines(_ path: String) throws -> [String] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The style lines that follow each line starting with `start`.
    private func styles(_ l: [String], _ start: String, count: Int) -> [String] {
        l.indices.filter { l[$0].hasPrefix(start) }.map { l[($0 + 1)...($0 + count)].joined(separator: " ") }
    }

    func testCardsShowAddedSmallerAndDimmerThanId() throws {
        let l = try lines("App/Views/PeersView.swift")
        let added = styles(l, "Text(\"Added: \"", count: 2)
        XCTAssertEqual(added.count, 3)
        for s in added { XCTAssertEqual(s, ".font(.caption) .foregroundStyle(.secondary)") }
        let id = styles(l, "Text(\"ID: \"", count: 2)
        XCTAssertEqual(id.count, 3)
        for s in id { XCTAssertEqual(s, ".font(.subheadline) .foregroundColor(.secondaryText)") }
    }

    func testLimitPickerShowsAddedSmallerAndDimmerThanId() throws {
        let l = try lines("App/Views/LimitPickerView.swift")
        XCTAssertEqual(styles(l, "Text(\"Added: \"", count: 1), [".font(.caption2).foregroundStyle(.secondary)"])
        XCTAssertEqual(styles(l, "Text(\"ID: \"", count: 1), [".font(.caption).foregroundColor(.secondaryText)"])
    }
}
