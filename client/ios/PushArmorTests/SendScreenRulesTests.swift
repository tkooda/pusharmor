import XCTest
import PushArmorCore
@testable import PushArmor

/// Send screen rules: chip header, "All" chip, counter threshold, sole device, caption, "Send as URL" (F12, F13).
final class SendScreenRulesTests: XCTestCase {
    func testHeaderCountsSelectedOfTotal() {
        XCTAssertEqual(SendScreenRules.header(selected: 6, total: 9), "Send to (6 of 9)")
        XCTAssertEqual(SendScreenRules.header(selected: 0, total: 1), "Send to (0 of 1)")
    }

    func testAllChipNeedsTwoDevicesAndTheSetting() {
        XCTAssertFalse(SendScreenRules.showsAll(setting: true, deviceCount: 0))
        XCTAssertFalse(SendScreenRules.showsAll(setting: true, deviceCount: 1))
        XCTAssertTrue(SendScreenRules.showsAll(setting: true, deviceCount: 2))
        XCTAssertTrue(SendScreenRules.showsAll(setting: true, deviceCount: 9))
        XCTAssertFalse(SendScreenRules.showsAll(setting: false, deviceCount: 9))
    }

    func testCounterShowsFromNinetyPercent() {
        let cap = SizeCap.bytes
        let below = (cap * 9 + 9) / 10 - 1
        XCTAssertFalse(SendScreenRules.showsCounter(""))
        XCTAssertFalse(SendScreenRules.showsCounter(String(repeating: "a", count: below)))
        XCTAssertTrue(SendScreenRules.showsCounter(String(repeating: "a", count: below + 1)))
        XCTAssertTrue(SendScreenRules.showsCounter(String(repeating: "a", count: cap + 1)))
    }

    func testSoleDeviceIsPreselectedOnlyWhenItCanReceive() {
        XCTAssertEqual(SendScreenRules.soleDevice([(id: "a", canReceive: true)]), "a")
        XCTAssertNil(SendScreenRules.soleDevice([(id: "a", canReceive: false)]))
        XCTAssertNil(SendScreenRules.soleDevice([(id: "a", canReceive: true), (id: "b", canReceive: true)]))
        XCTAssertNil(SendScreenRules.soleDevice([]))
    }

    func testCaptionIsPresentTenseAndFollowsSendAsText() {
        XCTAssertEqual(SendScreenRules.caption(.url, asText: false).title, "Will open as a URL")
        XCTAssertEqual(SendScreenRules.caption(.tel, asText: false).title, "Will open as a phone number")
        XCTAssertEqual(SendScreenRules.caption(.text, asText: false).title, "Will arrive as text")
        XCTAssertEqual(SendScreenRules.caption(.url, asText: true).title, "Will arrive as text")
        XCTAssertEqual(SendScreenRules.caption(.tel, asText: true).title, "Will arrive as text")
    }

    func testSendTypeKeepsPhoneNumbersAndLeavesURLsToTheDetection() {
        XCTAssertEqual(SendScreenRules.sendType("+1 555-123-4567", asURL: false, asText: false), .tel)
        XCTAssertEqual(SendScreenRules.sendType("tel:+1 555-123-4567", asURL: false, asText: false), .tel)
        XCTAssertEqual(SendScreenRules.sendType("+1 555-123-4567", asURL: false, asText: true), .text)
        XCTAssertEqual(SendScreenRules.sendType("https://example.com/x", asURL: false, asText: false), .text)
        XCTAssertEqual(SendScreenRules.sendType("hello", asURL: false, asText: false), .text)
        XCTAssertEqual(SendScreenRules.sendType("https://example.com/x", asURL: true, asText: false), .url)
    }

    func testPhoneNumbersAreNeverLikelyURLs() {
        for s in ["+1 555-123-4567", "tel:+1 555-123-4567", "555.123.4567", "(555) 123-4567"] {
            XCTAssertFalse(LikelyURL.isLikely(s), s)
        }
    }

    func testLikelyURLAcceptsHostShapes() {
        for s in ["minilock.org", "  minilock.org  ", "https://minilock.org", "HTTP://a.b.co/x?y#z",
                  "sub.example.com:8080/path", "example.com/", "xn--bcher-kva.xn--p1ai",
                  "https://1.2.3.4", "http://localhost:8080/x"] {
            XCTAssertTrue(LikelyURL.isLikely(s), s)
        }
    }

    func testLikelyURLRejectsOtherText() {
        for s in ["minilock.", "minilockorg", "minilock.;org", "minilock .org", "", "   ", "a..com", "-a.com",
                  "1.2.3.4", "hello world.com", "localhost", "ftp://x.com", "https://"] {
            XCTAssertFalse(LikelyURL.isLikely(s), s)
        }
    }

    func testSendAsURLPayloadIsTrimmedWithAScheme() {
        XCTAssertEqual(LikelyURL.payload("  minilock.org  "), "https://minilock.org")
        XCTAssertEqual(LikelyURL.payload("https://minilock.org"), "https://minilock.org")
        XCTAssertEqual(LikelyURL.payload(" HTTP://a.b.co/x?y#z"), "HTTP://a.b.co/x?y#z")
        XCTAssertEqual(LikelyURL.payload("sub.example.com:8080/path"), "https://sub.example.com:8080/path")
    }

    func testDetectedTypeUrlWinsThenPhoneThenText() {
        XCTAssertEqual(SendScreenRules.detected("minilock.org"), .url)
        XCTAssertEqual(SendScreenRules.detected("https://example.com/x"), .url)
        XCTAssertEqual(SendScreenRules.detected("+1 555-123-4567"), .tel)
        XCTAssertEqual(SendScreenRules.detected("tel:+1 555-123-4567"), .tel)
        XCTAssertEqual(SendScreenRules.detected("hello"), .text)
        XCTAssertEqual(SendScreenRules.detected(""), .text)
    }

    func testSendAsTextIsOfferedOnlyForAUrlOrPhoneNumber() {
        var c = SendAsTextChoice()
        XCTAssertFalse(c.offered)
        XCTAssertFalse(c.on)
        c.set(true)
        XCTAssertFalse(c.on)
        c.textChanged("minilock.org")
        XCTAssertTrue(c.offered)
        XCTAssertEqual(c.type, .url)
        c.textChanged("+1 555-123-4567")
        XCTAssertTrue(c.offered)
        XCTAssertEqual(c.type, .tel)
        c.textChanged("hello")
        XCTAssertFalse(c.offered)
        XCTAssertEqual(c.type, .text)
        // a restored draft starts from its text
        XCTAssertEqual(SendAsTextChoice(text: "minilock.org").type, .url)
    }

    func testSendAsTextOverridesToTextUntilTheDetectedTypeChanges() {
        var c = SendAsTextChoice(text: "minilock.org")
        c.set(true)
        XCTAssertEqual(c.type, .text)
        // same detected type: the override stays
        c.textChanged("minilock.org/x")
        XCTAssertTrue(c.on)
        // the detected type changes: the override resets
        c.textChanged("hello")
        XCTAssertFalse(c.on)
        c.textChanged("minilock.org")
        XCTAssertFalse(c.on)
        XCTAssertEqual(c.type, .url)
        c.set(true)
        c.textChanged("+1 555-123-4567")
        XCTAssertFalse(c.on)
        XCTAssertEqual(c.type, .tel)
    }

    func testSendAsTextWinsInSendType() {
        XCTAssertEqual(SendScreenRules.sendType("minilock.org", asURL: true, asText: true), .text)
        XCTAssertEqual(SendScreenRules.sendType("minilock.org", asURL: true, asText: false), .url)
    }

    /// A send starts the choice over: the success branch clears the draft and the choice.
    func testSendStartsSendAsTextOver() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/ComposeView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        let reset = try NSRegularExpression(pattern: #"text = \"\"\s*typeChoice = SendAsTextChoice\(\)"#)
        XCTAssertEqual(reset.numberOfMatches(in: src, range: NSRange(src.startIndex..., in: src)), 1)
    }

    func testKeyboardUpShowsOnlyChosenDevicesInListOrder() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(SendScreenRules.visibleChips(ids, recipients: ["c", "a"], keyboardUp: false), ids)
        XCTAssertEqual(SendScreenRules.visibleChips(ids, recipients: ["c", "a"], keyboardUp: true), ["a", "c"])
    }

    func testKeyboardUpWithNoneChosenShowsAllDevices() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(SendScreenRules.visibleChips(ids, recipients: [], keyboardUp: true), ids)
        XCTAssertEqual(SendScreenRules.visibleChips(ids, recipients: ["x"], keyboardUp: true), ids)
    }

    func testAllChipWithKeyboardUpShowsOnlyWhileOn() {
        XCTAssertTrue(SendScreenRules.showsAllChip(available: true, on: false, keyboardUp: false))
        XCTAssertTrue(SendScreenRules.showsAllChip(available: true, on: true, keyboardUp: true))
        XCTAssertFalse(SendScreenRules.showsAllChip(available: true, on: false, keyboardUp: true))
        XCTAssertFalse(SendScreenRules.showsAllChip(available: false, on: true, keyboardUp: false))
    }

    func testChipAreaIsShorterWithKeyboardUp() {
        XCTAssertLessThan(SendScreenRules.chipAreaMaxHeight(keyboardUp: true), SendScreenRules.chipAreaMaxHeight(keyboardUp: false))
    }

    func testMessageFieldStartsAtFourLinesAndStopsAtTheVisibleArea() {
        let h = SendScreenRules.messageHeight(lineHeight: 22, visible: 600)
        XCTAssertEqual(h.min, 104)
        XCTAssertEqual(h.max, 600 - SendScreenRules.messageChrome)
        // Keyboard up on a small screen: never below the 4 line start.
        XCTAssertEqual(SendScreenRules.messageHeight(lineHeight: 22, visible: 120).max, 104)
        // Before the first layout pass the visible height is 0.
        XCTAssertEqual(SendScreenRules.messageHeight(lineHeight: 22, visible: 0).max, 104)
    }

    func testSendTitleNamesASingleRecipient() {
        XCTAssertEqual(SendScreenRules.sendTitle(count: 0, soleName: nil), "Send")
        XCTAssertEqual(SendScreenRules.sendTitle(count: 1, soleName: "Laptop"), "Send to \"Laptop\"")
        XCTAssertEqual(SendScreenRules.sendTitle(count: 1, soleName: nil), "Send to 1 device")
        XCTAssertEqual(SendScreenRules.sendTitle(count: 3, soleName: nil), "Send to 3 devices")
    }

    /// The Send button clears the draft only when the send succeeded (f7db107). The view is
    /// SwiftUI state, so this reads its source: the only draft clear sits inside the success branch.
    func testFailedSendKeepsTheDraft() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/ComposeView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        let guarded = try NSRegularExpression(
            pattern: #"if await RecipientMemory\.send\(sel, \{[^\n]*\}\) \{\s*text = \"\""#)
        XCTAssertEqual(guarded.numberOfMatches(in: src, range: NSRange(src.startIndex..., in: src)), 1)
        // The guarded clear is the only clear of the draft (the @State starts from the saved draft).
        XCTAssertEqual(src.components(separatedBy: "text = \"\"").count - 1, 1)
    }
}
