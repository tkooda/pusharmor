import XCTest
@testable import PushArmor

/// Refresh and pull-to-refresh on the Devices screen are greyed 10 s after use, with no countdown.
/// Check again and Try again are also greyed 10 s; other buttons only while their tap runs.
@MainActor
final class RefreshGreyTests: XCTestCase {
    func testGreyTimeIsTenSeconds() {
        XCTAssertEqual(AppModel.refreshGreySeconds, 10)
        XCTAssertLessThan(AppModel().refreshGreyUntil, Date())   // a new model starts with Refresh on
    }

    /// Try again on a pairing card is greyed 10 s after a tap; a tap meanwhile does nothing.
    func testTryAgainGreyTimeIsTenSeconds() {
        let m = AppModel()
        let t = Date()
        XCTAssertFalse(m.tryAgainGreyed("p1", at: t))
        XCTAssertTrue(m.startTryAgainGrey("p1", at: t))
        XCTAssertTrue(m.tryAgainGreyed("p1", at: t.addingTimeInterval(9.9)))
        XCTAssertFalse(m.startTryAgainGrey("p1", at: t.addingTimeInterval(9.9)))
        XCTAssertFalse(m.tryAgainGreyed("p2", at: t))
        XCTAssertFalse(m.tryAgainGreyed("p1", at: t.addingTimeInterval(10)))
        XCTAssertTrue(m.startTryAgainGrey("p1", at: t.addingTimeInterval(10)))
    }

    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func count(_ pattern: String, in s: String) throws -> Int {
        try NSRegularExpression(pattern: pattern).numberOfMatches(in: s, range: NSRange(s.startIndex..., in: s))
    }

    /// Check again on the "cannot receive" banner is greyed 10 s after a tap; a tap meanwhile does nothing.
    func testCheckAgainGreyTimeIsTenSeconds() async throws {
        XCTAssertEqual(AppModel.checkGreySeconds, 10)
        let m = AppModel()
        let t = Date()
        XCTAssertFalse(m.checkGreyed(at: t))
        XCTAssertTrue(m.startCheckGrey(at: t))
        XCTAssertTrue(m.checkGreyed(at: t.addingTimeInterval(9.9)))
        XCTAssertFalse(m.startCheckGrey(at: t.addingTimeInterval(9.9)))
        XCTAssertFalse(m.checkGreyed(at: t.addingTimeInterval(10)))
        let until = Date().addingTimeInterval(5)
        m.checkGreyUntil = until
        await m.checkAgain()
        XCTAssertEqual(m.checkGreyUntil, until)
        XCTAssertNil(m.toast)
        let banner = try source("App/Views/RootView.swift")
        XCTAssertEqual(try count(#"model\.checkGreyed\(at: ctx\.date\)"#, in: banner), 1)
    }

    /// Only Refresh, Try again, and Check again have a grey time. Send, Remove, Rename, Pair,
    /// and sign-in have none: a double tap is stopped only while the first tap still runs.
    func testInFlightGuardsWithNoGreyTime() throws {
        let model = try source("App/AppModel.swift")
        XCTAssertEqual(try count(#"@Published var \w+GreyUntil"#, in: model), 3)
        for key in [#""sendCode""#, #""apple""#, #""reply:" \+ p\.id\.text"#, #""rename""#] {
            XCTAssertEqual(try count(#"await once\("# + key, in: model), 1, key)
        }
        let signIn = try source("App/Views/SignInView.swift")
        XCTAssertEqual(try count(#"\.disabled\(model\.busy\.contains\("apple"\)\)"#, in: signIn), 1)
        XCTAssertEqual(try count(#"model\.once\("google"\)"#, in: signIn), 1)
        XCTAssertEqual(try count(#"\.disabled\(model\.busy\.contains\("google"\)\)"#, in: signIn), 1)
        XCTAssertEqual(try count(#"model\.busy\.contains\("sendCode"\)"#, in: signIn), 1)
        XCTAssertFalse(signIn.contains("Grey"))
        let peers = try source("App/Views/PeersView.swift")
        XCTAssertEqual(try count(#"Button\("Reply"\)[^\n]*\n[^\n]*\n\s*\.disabled\(model\.busy\.contains\("reply:" \+ p\.id\.text\)\)"#, in: peers), 1)
        let settings = try source("App/Views/SettingsView.swift")
        XCTAssertEqual(try count(#"guard renaming, NameEntry\.isValidName\(name\)"#, in: settings), 1)
    }
}
