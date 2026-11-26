import XCTest
import PushArmorCore

/// A closed file row whose image does not decode keeps "Preview not available" under its name;
/// its buttons show only while the row is open.
final class CollapsedPreviewTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testRule() {
        XCTAssertTrue(FileUi.previewNotAvailable(name: "a.png", decodes: false))
        XCTAssertFalse(FileUi.previewNotAvailable(name: "a.png", decodes: true))
        XCTAssertFalse(FileUi.previewNotAvailable(name: "a.pdf", decodes: false))
    }

    func testClosedRowKeepsTheLine() throws {
        let row = try source("App/Views/HistoryView.swift")
        XCTAssertTrue(row.contains("if case .ready = model.fileStatus(f) { return FileUi.previewNotAvailable(name: f.name, decodes: decodes ?? true) }"))
        XCTAssertTrue(row.contains("decodes = await Task.detached { FileRowDetail.decodes(url) }.value"))
        let files = try source("App/Views/FileViews.swift")
        let ready = files.components(separatedBy: "private var ready: some View")[1].components(separatedBy: "nonisolated static func decodes")[0]
        let line = try XCTUnwrap(ready.range(of: "Text(FileUi.previewNA)"))
        let gate = try XCTUnwrap(ready.range(of: "if open {\n                HStack(spacing: 10) {"))
        XCTAssertLessThan(line.lowerBound, gate.lowerBound)
    }
}
