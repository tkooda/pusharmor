import XCTest

/// The file parts of the Send screen, Settings, History, and the share sheet. The views are
/// SwiftUI state (and the share sheet an extension target), so these read their sources.
final class FileScreensTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// "Will be sent as ..." shows only once the box has content or a file is chosen; the file
    /// buttons show only while the box is empty; a chosen file replaces the box.
    func testSendScreenFileRules() throws {
        let src = try source("App/Views/ComposeView.swift")
        XCTAssertTrue(src.contains("if chosen != nil {\n                Label(FileUi.willSendFile"))
        XCTAssertTrue(src.contains("} else if !text.isEmpty {"))
        XCTAssertTrue(src.contains(".overlay(alignment: .bottomTrailing) {\n                        if text.isEmpty {"))
        XCTAssertTrue(src.contains("PasteButton(payloadType: PastedImage.self)"))
        XCTAssertTrue(src.contains("Label(FileUi.chooseFile, systemImage: \"paperclip\")"))
        XCTAssertTrue(src.contains("if let c = chosen {\n                fileCard(c)"))
        XCTAssertTrue(src.contains(".accessibilityLabel(FileUi.removeFile)"))
        XCTAssertTrue(src.contains("guard Int64(size) <= FileRules.maxFile else {\n            model.toast = FileUi.tooLarge(name)"))
        XCTAssertTrue(src.contains("sendCaption = FileUi.sending(to: sendNames)"))
    }

    /// Settings: the helper text above both pickers, then the storage limit and its helper.
    func testSettingsFilesSection() throws {
        XCTAssertTrue(try source("App/Views/SettingsView.swift").contains("FileSettingsSection()"))
        let src = try source("App/Views/FileViews.swift")
        let section = src.components(separatedBy: "struct FileSettingsSection")[1]
        let order = ["Text(FileUi.helper)", "picker(FileUi.onWifi, FileSettingKey.wifi)", "picker(FileUi.onMobile, FileSettingKey.mobile)",
                     "Picker(FileUi.storageTitle", "Text(FileUi.storageHelper)"]
        let at = order.map { section.range(of: $0)?.lowerBound }
        XCTAssertFalse(at.contains(nil))
        XCTAssertEqual(at.compactMap { $0 }, at.compactMap { $0 }.sorted())
    }

    /// History: a file row shows its state and buttons under it and never opens; decrypts run
    /// only while History shows.
    func testHistoryFileRows() throws {
        let row = try source("App/Views/HistoryView.swift")
        XCTAssertTrue(row.contains("if let f = file, !selecting { FileRowDetail(file: f, outgoing: outgoing) }"))
        XCTAssertTrue(row.contains("if isUnknownType || isFile { return }"))
        XCTAssertTrue(row.contains("ForEach(model.pendingSends, id: \\.id) { PendingSendRow(file: $0) }"))
        let main = try source("App/Views/MainView.swift")
        XCTAssertTrue(main.contains(".onAppear { model.setHistoryVisible(true) }"))
        XCTAssertTrue(main.contains(".onDisappear { model.setHistoryVisible(false) }"))
        let model = try source("App/FileModel.swift")
        XCTAssertTrue(model.contains("guard historyVisible, UIApplication.shared.applicationState == .active, !decryptRunning"))
        let views = try source("App/Views/FileViews.swift")
        XCTAssertTrue(views.contains("downloadRow(exp)"))
        XCTAssertTrue(views.contains("Button { model.decryptNow(file) } label: { Label(\"Decrypt\""))
        XCTAssertTrue(views.contains(".quickLookPreview($preview)"))
    }

    /// Share sheet: one photo, video, or file opens it; a file sends with the popup on the upload,
    /// and Close leaves the upload to finish in the background.
    func testShareSheetFiles() throws {
        let yml = try source("project.yml")
        for k in ["NSExtensionActivationSupportsImageWithMaxCount: 1", "NSExtensionActivationSupportsMovieWithMaxCount: 1",
                  "NSExtensionActivationSupportsFileWithMaxCount: 1"] {
            XCTAssertTrue(yml.contains(k), k)
        }
        let src = try source("Share/ShareViewController.swift")
        XCTAssertTrue(src.contains("if let f = file { return await sendFile(f, to: ids) }"))
        XCTAssertTrue(src.contains("guard shown.on else { return false }"))
        XCTAssertTrue(src.contains("shown.on = false\n        context?.completeRequest(returningItems: nil)"))
        XCTAssertTrue(src.contains("guard Int64(size) <= FileRules.maxFile else {"))
    }
}
