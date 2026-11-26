import XCTest
@testable import PushArmorCore

/// Toasts and errors that name a file cut a long name in the middle, to 24 characters, so the
/// message fits.
final class FileToastNameTests: XCTestCase {
    private let long = "Quarterly financial report final version 2.pdf"

    func testCutKeepsStartAndEnd() {
        XCTAssertEqual(FileUi.toastNameMax, 24)
        let cut = FileUi.cutName(long)
        XCTAssertEqual(cut, "Quarterly fina...n 2.pdf")
        XCTAssertEqual(cut.count, 24)
        XCTAssertEqual(FileUi.cutName("report.pdf"), "report.pdf")
        let exact = String(repeating: "a", count: 20) + ".pdf"
        XCTAssertEqual(FileUi.cutName(exact), exact)
    }

    func testEveryFileToastUsesTheCut() {
        let c = FileUi.cutName(long)
        XCTAssertEqual(FileUi.tooLarge(long), "\"" + c + "\" is too large to send")
        XCTAssertEqual(FileUi.unreadable(long), "Unable to read \"" + c + "\"")
        XCTAssertEqual(FileUi.noApp(long), "No app can open \"" + c + "\"")
        XCTAssertEqual(FileUi.saved(long), "Saved \"" + c + "\"")
        XCTAssertEqual(FileUi.copyFailed(long), "Unable to copy \"" + c + "\"")
        XCTAssertEqual(FileUi.openFailed(long), "Unable to decrypt \"" + c + "\"\nTry again")
        XCTAssertEqual(FileUi.noMemoryToast(long), "Not enough memory to decrypt \"" + c + "\"")
        XCTAssertEqual(FileUi.saveFailed(long, CocoaError(.fileWriteUnknown)), "Unable to save \"" + c + "\"")
        XCTAssertEqual(FileRules.storageFullText(upload: true, name: long), "Not enough storage to send \"" + c + "\"")
    }
}
