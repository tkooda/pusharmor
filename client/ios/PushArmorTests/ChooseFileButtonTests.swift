import XCTest
import PushArmorCore

/// The Send screen file button: a small secondary text button, "Or choose a file...".
final class ChooseFileButtonTests: XCTestCase {
    func testLabel() {
        XCTAssertEqual(FileUi.chooseFile, "Or choose a file...")
    }

    func testSecondaryStyle() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/ComposeView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(src.contains("Label(FileUi.chooseFile, systemImage: \"paperclip\") }\n"
            + "                                    .buttonStyle(.borderless)\n"
            + "                                    .controlSize(.small)"))
        XCTAssertFalse(src.contains("Label(FileUi.chooseFile, systemImage: \"paperclip\") }\n                                    .buttonStyle(.bordered)"))
    }
}
