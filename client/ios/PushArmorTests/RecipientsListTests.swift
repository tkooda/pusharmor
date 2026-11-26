import XCTest

/// An opened History item sent to two or more devices shows a "Recipients" disclosure (a stock
/// control: its own VoiceOver button with an expanded or collapsed state) just above its
/// buttons. It lives only inside the opened item, so closing the item closes the list.
final class RecipientsListTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testRecipientsIsAStockDisclosureThatStartsClosed() throws {
        let src = try source("App/Views/HistoryView.swift")
        let list = src.components(separatedBy: "struct RecipientsList")[1].components(separatedBy: "struct HistoryRowView")[0]
        XCTAssertTrue(list.contains("@State private var open = false"))
        XCTAssertTrue(list.contains("DisclosureGroup(HistoryRecipients.title, isExpanded: $open)"))
        XCTAssertTrue(src.contains("if isOpen { MessageDetailView(row: row, notDeletedOn: notDeletedOn, recipients: recipientLines) }"))
        XCTAssertTrue(src.contains("model.historyLabel($0)"))
    }

    func testRecipientsSitJustAboveTheButtons() throws {
        let detail = try source("App/Views/MessageDetailView.swift")
        let list = try XCTUnwrap(detail.range(of: "if !recipients.isEmpty { RecipientsList(lines: recipients) }"))
        let buttons = try XCTUnwrap(detail.range(of: "if typeSize >= .accessibility1 {"))
        XCTAssertLessThan(list.lowerBound, buttons.lowerBound)
        let files = try source("App/Views/FileViews.swift")
        let fileList = try XCTUnwrap(files.range(of: "if open, !recipients.isEmpty { RecipientsList(lines: recipients) }"))
        let incoming = try XCTUnwrap(files.range(of: "if !outgoing || file.state != \"sent\" {\n                incoming"))
        XCTAssertLessThan(fileList.lowerBound, incoming.lowerBound)
    }
}
