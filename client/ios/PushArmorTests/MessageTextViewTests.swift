import XCTest
import UIKit
@testable import PushArmor

/// an opened message shows its text as plain text: nothing is detected as a link, phone
/// number, or date, and markup is not rendered.
@MainActor
final class MessageTextViewTests: XCTestCase {
    func testMessageTextIsPlain() {
        let s = "<b>x</b> call +1 555 0100 or open https://example.com tomorrow at 5 pm"
        let v = SelectableText.makeTextView(text: s)
        XCTAssertFalse(v.isEditable)
        XCTAssertTrue(v.isSelectable)
        XCTAssertTrue(v.dataDetectorTypes.isEmpty)
        XCTAssertEqual(v.text, s)
        var keys = Set<NSAttributedString.Key>()
        v.attributedText.enumerateAttributes(in: NSRange(location: 0, length: v.attributedText.length)) { attrs, _, _ in
            keys.formUnion(attrs.keys)
        }
        XCTAssertFalse(keys.contains(.link))
    }
}
