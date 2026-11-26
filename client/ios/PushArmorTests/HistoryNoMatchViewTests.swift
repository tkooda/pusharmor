import XCTest

/// History: a selected filter that matches nothing shows the gray centered "No matching
/// messages" and stays selected; it never falls back to All.
final class HistoryNoMatchViewTests: XCTestCase {
    func testNoFallbackToAll() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/HistoryView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("private var effective: HistoryFilter { HistoryFilter.current(filter, options: options) }"))
        XCTAssertFalse(src.contains("HistoryFilter.apply(filter, model.history).isEmpty"))
        XCTAssertTrue(src.contains("if rows.isEmpty && pending.isEmpty && effective != .all {\n                Text(HistoryFilter.noMatch)\n                    .foregroundColor(.secondaryText)\n                    .multilineTextAlignment(.center)\n                    .frame(maxWidth: .infinity)"))
        // the selected filter stays among the choices while it has no rows
        XCTAssertTrue(src.contains("ForEach(choices, id: \\.self) { Text($0.label).tag($0) }"))
        XCTAssertFalse(src.contains("ForEach(options, id: \\.self)"))
        XCTAssertTrue(src.contains("if choices.count > 1 {\n                filterControl"))
    }
}
