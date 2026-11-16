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

    /// Too long text: an editable box with the Send screen's counter, and Send greyed until it
    /// fits; no send of a part.
    func testTooLongEditsWithCounterAndGreyedSend() throws {
        let src = try source()
        let view = src.components(separatedBy: "private var tooLong: some View {")[1]
            .components(separatedBy: "var body: some View")[0]
        XCTAssertTrue(view.contains("TextEditor(text: $model.text)"))
        XCTAssertTrue(view.contains("if SizeCap.isWarning(model.text) {\n                Text(SizeCap.label(model.text))"))
        XCTAssertTrue(view.contains(".frame(maxWidth: .infinity, alignment: .trailing)"))
        XCTAssertTrue(view.contains(".disabled(SizeCap.isOver(model.text) ||"))
        XCTAssertTrue(src.contains("guard !SizeCap.isOver(text) else { return }"))
        XCTAssertFalse(src.contains("truncate"))
        XCTAssertFalse(src.contains("Send the first"))
    }

    /// The send shows the Send screen's progress popup while it is on its way.
    func testSendShowsTheSendPopup() throws {
        let src = try source()
        XCTAssertTrue(src.contains("SendPopup(caption: model.sendCaption, names: model.sendNames, step: model.sendStep, retry: model.sendRetry)"))
        XCTAssertTrue(src.contains("SendProgress.$step.withValue"))
        XCTAssertTrue(src.contains("SendProgress.$retry.withValue"))
    }

    /// The top-left button reads Cancel until the result shows, then Done.
    func testDoneAfterTheResult() throws {
        let src = try source()
        XCTAssertTrue(src.contains("Button(model.finished ? \"Done\" : \"Cancel\")"))
        XCTAssertTrue(src.contains("case .done, .failed: return true"))
    }

    /// A URL or phone number over the cap greys out Send like text, with no error.
    func testTooLongURLGreysOutSendToo() throws {
        let src = try source()
        let check = src.components(separatedBy: "if SizeCap.isOver(text) {")[1].components(separatedBy: "return")[0]
        XCTAssertTrue(check.contains("step = .tooLong"))
        XCTAssertFalse(check.contains("type =="))
        XCTAssertFalse(src.contains("Core.SendError.tooLong"))
    }

    /// A failed send stays on screen; only a sent message closes the sheet by itself.
    func testOnlySuccessAutoCloses() throws {
        let src = try source()
        let send = src.components(separatedBy: "func send(to ids: [PeerId]) async {")[1]
            .components(separatedBy: "func close()")[0]
        XCTAssertTrue(send.contains("step = .failed(ErrorCopy.sendFailText(error))\n            return"))
        XCTAssertFalse(send.contains("step = .done(ErrorCopy"))
    }
}
