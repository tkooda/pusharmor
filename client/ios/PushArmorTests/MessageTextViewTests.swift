import XCTest
import SwiftUI
import UIKit
@testable import PushArmor

/// an opened message shows its text as plain text: nothing is detected as a link, phone
/// number, or date, and markup is not rendered.
@MainActor
final class MessageTextViewTests: XCTestCase {
    /// The reader screen the app shows, rendered in a window: its text view is the one
    /// SwiftUI made through SelectableText.makeUIView.
    func testMessageTextIsPlain() throws {
        let s = "<b>x</b> call +1 555 0100 or open https://example.com tomorrow at 5 pm"
        let host = UIHostingController(rootView: ReadMessageView(text: s))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        func textViews(_ v: UIView) -> [UITextView] {
            ((v as? UITextView).map { [$0] } ?? []) + v.subviews.flatMap { textViews($0) }
        }
        let found = textViews(host.view)
        XCTAssertEqual(found.count, 1)
        let v = try XCTUnwrap(found.first)
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
