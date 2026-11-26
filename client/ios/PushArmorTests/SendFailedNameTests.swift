import XCTest
@testable import PushArmor

/// The failed-send text of a file cuts a long name in the middle, like every file toast.
final class SendFailedNameTests: XCTestCase {
    func testLongNameIsCut() {
        XCTAssertEqual(FileTransfers.sendFailedText("Quarterly financial report final version 2.pdf"),
                       "Unable to send \"Quarterly fina...n 2.pdf\"")
        XCTAssertEqual(FileTransfers.sendFailedText("a.pdf"), "Unable to send \"a.pdf\"")
    }
}
