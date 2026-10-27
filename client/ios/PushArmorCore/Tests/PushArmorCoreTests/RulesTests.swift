import XCTest
@testable import PushArmorCore

final class RulesTests: XCTestCase {
    func testReplayWindow() {
        var w = ReplayWindow()
        XCTAssertEqual(w.check(1), .accept)
        w.accept(1)
        XCTAssertEqual(w.check(1), .seen)
        w.accept(5)
        XCTAssertEqual(w.h, 5)
        XCTAssertEqual(w.check(3), .accept)   // out of order inside the window
        w.accept(3)
        XCTAssertEqual(w.check(3), .seen)
        XCTAssertEqual(w.check(1), .seen)
        XCTAssertEqual(w.check(2), .accept)
        w.accept(104)
        XCTAssertEqual(w.check(4), .tooOld)   // n <= h - 100
        XCTAssertEqual(w.check(5), .seen)     // h - 99, still tracked
        XCTAssertEqual(w.check(6), .accept)
        XCTAssertEqual(w.check(104), .seen)
        w.accept(300)                          // shift >= 100 clears
        XCTAssertEqual(w.check(201), .accept)
        XCTAssertEqual(w.check(200), .tooOld)
        XCTAssertEqual(w.check(300), .seen)
        let r = ReplayWindow(h: w.h, blob: w.blob)!
        XCTAssertEqual(r, w)
        XCTAssertEqual(w.blob.count, 13)
        XCTAssertNil(ReplayWindow(h: 1, blob: Data(count: 12)))
        // window of 0: n = 0 is never valid input (parser rejects); h = 0 accepts 1
        XCTAssertEqual(ReplayWindow().check(1), .accept)
    }

    func testReplayWindowBitShift() {
        var w = ReplayWindow()
        for n in [10, 8, 6] as [UInt64] { w.accept(n) }
        w.accept(12) // shift 2: bits 0,2,4 -> 2,4,6, then bit 0
        for n in [12, 10, 8, 6] as [UInt64] { XCTAssertEqual(w.check(n), .seen, "\(n)") }
        for n in [11, 9, 7, 5] as [UInt64] { XCTAssertEqual(w.check(n), .accept, "\(n)") }
        w.accept(111) // shift 99: only n = 12 (k = 11 -> 110? no: 12 -> k 99) stays
        XCTAssertEqual(w.check(12), .seen)
        XCTAssertEqual(w.check(11), .tooOld)
    }

    func testPhoneDetection() {
        for s in ["+1 555-123-4567", "(555) 123.4567", "tel:+15551234567", " 5551234 ", "\u{a0}+44 20 7946 0958\u{a0}"] {
            XCTAssertTrue(PhoneDetection.isPhone(s), s)
        }
        for s in ["2026-10-24", "10.0.0.1", "123456", "24.10.2026", "abc", "+1 555 123 4567 8901 234", "\u{0661}\u{0662}\u{0663}4567890"] {
            XCTAssertFalse(PhoneDetection.isPhone(s), s)
        }
    }

    func testSendDetection() {
        XCTAssertEqual(SendDetection.detect("tel:+1 555-123-4567"), .tel)
        XCTAssertEqual(SendDetection.detect("https://example.com/x"), .url)
        XCTAssertEqual(SendDetection.detect(" HTTP://Example.com "), .url)
        XCTAssertEqual(SendDetection.detect("+1 555-123-4567"), .tel)
        XCTAssertEqual(SendDetection.detect("hello"), .text)
        XCTAssertEqual(SendDetection.detect("ftp://example.com"), .text)
        XCTAssertEqual(SendDetection.detect("https://user:pw@example.com/"), .text)
        XCTAssertEqual(SendDetection.detect("see https://example.com"), .text)
        XCTAssertEqual(SendDetection.detect("2026-10-24"), .text)
    }

    func testSizeCap() {
        XCTAssertEqual(SizeCap.label("abc"), "(3 / 2048)")
        XCTAssertEqual(SizeCap.label(String(repeating: "a", count: 2049)), "Too long (2049 / 2048)")
        XCTAssertFalse(SizeCap.isWarning(String(repeating: "a", count: 1843)))
        XCTAssertTrue(SizeCap.isWarning(String(repeating: "a", count: 1844)))
        let s = String(repeating: "a", count: 2047) + "\u{e9}"   // 2049 bytes, cut before the 2-byte char
        XCTAssertEqual(SizeCap.truncated(s).utf8.count, 2047)
        XCTAssertEqual(SizeCap.truncated("abc"), "abc")
    }

    func testCountdown() {
        let t0: Int64 = 1_000_000
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0), "14 days")
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 13 * 86400 - 1), "1 day")
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 13 * 86400), "1 day")     // exactly 24 h left
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 13 * 86400 + 1), "23 hours")
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 14 * 86400 - 3600), "1 hour") // exactly 60 min
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 14 * 86400 - 3599), "60 minutes")
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 14 * 86400 - 3540), "59 minutes")
        XCTAssertEqual(Pairing.countdown(startedAt: t0, now: t0 + 14 * 86400 - 1), "1 minute")
        XCTAssertNil(Pairing.countdown(startedAt: t0, now: t0 + 14 * 86400))
        XCTAssertFalse(Pairing.isExpired(startedAt: t0, now: t0 + 13 * 86400))   // still valid at day 13
        XCTAssertTrue(Pairing.isExpired(startedAt: t0, now: t0 + 14 * 86400))
    }

    func testEmailCode() {
        XCTAssertEqual(EmailCode.clean("7kq-m9x"), "7KQM9X")
        XCTAssertEqual(EmailCode.clean("oIl u"), "011")
        XCTAssertEqual(EmailCode.submittable("7KQ M9X"), "7KQM9X")
        XCTAssertEqual(EmailCode.submittable("Your code:\n\n  7KQ-M9X\n\nNothing happens unless..."), "7KQM9X")
        XCTAssertNil(EmailCode.submittable("7KQM9"))
        XCTAssertEqual(EmailCode.submittable("7kqm9x"), "7KQM9X")
    }

    func testAPNsEnvironment() {
        XCTAssertEqual(APNsEnvironment.pushType(fileFound: false, env: nil, isSimulator: false), .apns)
        XCTAssertEqual(APNsEnvironment.pushType(fileFound: true, env: "production", isSimulator: false), .apns)
        XCTAssertEqual(APNsEnvironment.pushType(fileFound: true, env: "development", isSimulator: false), .apnsSandbox)
        XCTAssertEqual(APNsEnvironment.pushType(fileFound: false, env: nil, isSimulator: true), .apnsSandbox)
        XCTAssertEqual(APNsEnvironment.pushType(fileFound: true, env: nil, isSimulator: false), .apns)
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Entitlements</key><dict><key>aps-environment</key><string>development</string></dict></dict></plist>
        """
        let blob = Data([0x30, 0x82, 0x01]) + Data(plist.utf8) + Data([0xa0, 0x00])
        XCTAssertEqual(APNsEnvironment.apsEnvironment(provision: blob), "development")
        XCTAssertNil(APNsEnvironment.apsEnvironment(provision: Data([1, 2, 3])))
    }

    func testURLRule() {
        XCTAssertNotNil(URLRule.parse("https://example.com/a?b=c#d"))
        XCTAssertNotNil(URLRule.parse("HTTP://EXAMPLE.com"))
        XCTAssertNil(URLRule.parse("javascript:alert(1)"))
        XCTAssertNil(URLRule.parse("https:///path"))
        XCTAssertNil(URLRule.parse("https://u@example.com"))
        XCTAssertNil(URLRule.parse("file:///etc/passwd"))
        XCTAssertNil(URLRule.parse("two https://a.com https://b.com"))
    }

    /// I289: the banner userInfo starts empty; only "m" comes from the relay payload.
    func testBannerUserInfoKeepsOnlyM() {
        let b = Banner(body: "hi", locKey: nil, category: .url, threadId: "t", rowid: 7, tap: .openURL("https://a.com/"))
        let info = b.userInfo(m: "abc")
        XCTAssertEqual(Set(info.keys.compactMap { $0 as? String }), ["m", "rowid", "tap", "url"])
        XCTAssertEqual(info["m"] as? String, "abc")
        XCTAssertEqual((info["rowid"] as? NSNumber)?.int64Value, 7)
        XCTAssertEqual(info["tap"] as? String, "url")
        XCTAssertEqual(info["url"] as? String, "https://a.com/")
        let p = Banner(body: "x", locKey: nil, category: .event, threadId: "t", rowid: nil, tap: .peers(nil))
        XCTAssertEqual(Set(p.userInfo(m: nil).keys.compactMap { $0 as? String }), ["tap"])
    }

    /// I297: tap routing counts only with a valid stamp under the per-install key.
    func testTapStamp() throws {
        let path = NSTemporaryDirectory() + "pa-tap-\(UUID().uuidString).sqlite"
        let key = try TapStamp.key(try Store(path: path))
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(try TapStamp.key(try Store(path: path)), key)   // a second connection reads the same key
        let b = Banner(body: "hi", locKey: nil, category: .url, threadId: "t", rowid: 7, tap: .openURL("https://a.com/"))
        let good = b.userInfo(m: "abc", key: key)
        XCTAssertTrue(TapStamp.verified(good, key: key))
        // forged by the relay: no stamp, or a stamp moved to another row / tap
        var forged: [AnyHashable: Any] = ["m": "abc", "rowid": NSNumber(value: 7), "tap": "url"]
        XCTAssertFalse(TapStamp.verified(forged, key: key))
        forged = good; forged["rowid"] = NSNumber(value: 8)
        XCTAssertFalse(TapStamp.verified(forged, key: key))
        forged = good; forged["tap"] = "detail"
        XCTAssertFalse(TapStamp.verified(forged, key: key))
        forged = good; forged["peer"] = "x"
        XCTAssertFalse(TapStamp.verified(forged, key: key))
        XCTAssertFalse(TapStamp.verified(good, key: Data(count: 32)))
        XCTAssertFalse(TapStamp.verified(good, key: nil))
        XCTAssertFalse(TapStamp.verified(b.userInfo(m: "abc"), key: key))
    }

    /// I307: the expiry fallback keeps only "m" of a relay payload, whatever else it carries.
    func testExpiryUserInfo() {
        let relay: [AnyHashable: Any] = ["m": "abc", "aps": ["alert": ["title": "x", "body": "evil", "subtitle": "s"]],
                                         "rowid": NSNumber(value: 7), "tap": "url", "url": "https://evil.example/", "s": "x"]
        let info = Banner.expiryUserInfo(m: relay["m"])
        XCTAssertEqual(Set(info.keys.compactMap { $0 as? String }), ["m"])
        XCTAssertEqual(info["m"] as? String, "abc")
        XCTAssertTrue(Banner.expiryUserInfo(m: nil).isEmpty)
    }
}
