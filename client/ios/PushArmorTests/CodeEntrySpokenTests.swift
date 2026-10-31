import XCTest
@testable import PushArmor

/// I507: VoiceOver hears the entered code characters one by one.
@MainActor
final class CodeEntrySpokenTests: XCTestCase {
    func testSpokenValue() {
        XCTAssertEqual(CodeEntryView.spoken([]), "Empty")
        XCTAssertEqual(CodeEntryView.spoken(["A", "7", "K"]), "A 7 K, 3 of 6")
    }
}
