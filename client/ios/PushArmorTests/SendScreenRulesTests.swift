import XCTest
import PushArmorCore
@testable import PushArmor

/// Send screen rules: chip header, "All" chip, counter threshold, sole device, caption (F12, F13).
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
        XCTAssertEqual(SendScreenRules.caption(.url, asText: false).title, "Will open as a link")
        XCTAssertEqual(SendScreenRules.caption(.tel, asText: false).title, "Will open as a phone number")
        XCTAssertEqual(SendScreenRules.caption(.text, asText: false).title, "Will arrive as text")
        XCTAssertEqual(SendScreenRules.caption(.url, asText: true).title, "Will arrive as text")
        XCTAssertEqual(SendScreenRules.caption(.tel, asText: true).title, "Will arrive as text")
    }
}
