import XCTest
@testable import PushArmorCore

final class InboxTests: XCTestCase {
    func testLockedInboxCapAndDrain() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("one", as: .text, to: [x.id], allCount: 1)
        _ = try await n.core.send("two", as: .text, to: [x.id], allCount: 1)
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-inbox-\(UUID().uuidString)")
        let inbox = LockedInbox(dir: dir)
        var ms: Int64 = 1761300000000
        for m in w.take(x.id) { try inbox.write(m, nowMs: ms); ms += 1 }
        try inbox.write("not-a-message!", nowMs: ms)
        XCTAssertEqual(inbox.files().count, 3)
        let got = await x.core.drainLockedInbox(inbox)
        XCTAssertEqual(got, 2)
        XCTAssertEqual(inbox.files().count, 0)
        let h = try x.core.store.history()
        XCTAssertEqual(h.filter { $0.type == "text" && !$0.read }.map { $0.content }.sorted(), ["one", "two"])
        XCTAssertEqual(h.filter { $0.event == .couldNotRead }.count, 1)
        XCTAssertEqual(S.receivedWhileLocked(got), "2 messages received while locked")
        // cap: 100 files, the oldest goes first
        for i in 0 ..< 105 { try inbox.write("m\(i)", nowMs: 1761300000000 + Int64(i)) }
        let files = inbox.files()
        XCTAssertEqual(files.count, 100)
        XCTAssertEqual(try String(contentsOf: files[0], encoding: .ascii), "m5")
        inbox.removeAll()
    }

    func testPKCEAndTurnstileOrigin() {
        // RFC 7636 appendix B
        let p = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(PKCE.make().verifier.count, 43)
        XCTAssertTrue(TurnstileOrigin.accept(scheme: "https", host: "pusharmor.com", port: 0))
        XCTAssertFalse(TurnstileOrigin.accept(scheme: "http", host: "pusharmor.com", port: 0))
        XCTAssertFalse(TurnstileOrigin.accept(scheme: "https", host: "evil.pusharmor.com", port: 0))
        XCTAssertFalse(TurnstileOrigin.accept(scheme: "https", host: "pusharmor.com", port: 8443))
        let u = GoogleOAuth.authURL(clientId: "cid", redirect: "com.googleusercontent.apps.cid:/oauth", pkce: p, nonce: "nn", state: "st")
        XCTAssertTrue(u.absoluteString.contains("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"))
        XCTAssertTrue(u.absoluteString.contains("code_challenge_method=S256"))
    }

    func testPeerLabel() {
        XCTAssertEqual(PeerLabel.unnamed(platform: "android", created: 1759449600, timeZone: TimeZone(identifier: "UTC")!),
                       "Android peer added Oct 3")
        XCTAssertEqual(PeerLabel.platformName("iphone"), "iPhone")
    }
}

final class NSEFlowTests: XCTestCase {
    func testStepsOneTwoThree() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("hello", as: .text, to: [x.id], allCount: 1)
        let m = w.take(x.id)[0]
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        // missing m: drop with an event row
        var r = await NSEFlow.handle(m: nil, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        XCTAssertEqual(r.banner, .dropped)
        XCTAssertEqual(try x.core.store.history().first?.event, .couldNotRead)
        // before first unlock: locked inbox, no DB
        r = await NSEFlow.handle(m: m, loadKeys: { throw KeyLoadError.beforeFirstUnlock }, openCore: { _ in nil }, inbox: inbox,
                                 nowMs: 2, budgetLeft: { 30 })
        XCTAssertEqual(r.banner, .locked)
        XCTAssertEqual(inbox.files().count, 1)
        // any other Keychain error: drop, never the locked path
        r = await NSEFlow.handle(m: m, loadKeys: { throw KeyLoadError.other(-25300) }, openCore: { _ in nil }, inbox: inbox,
                                 nowMs: 3, budgetLeft: { 30 })
        XCTAssertEqual(r.banner, .dropped)
        XCTAssertEqual(inbox.files().count, 1)
        // normal path
        r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 4, budgetLeft: { 30 })
        XCTAssertEqual(r.banner?.body, "hello")
        XCTAssertTrue(r.committed)
        inbox.removeAll()
    }

    /// I308: a push the NSE dropped is marked handled under the stamp; the drain then counts no
    /// second could-not-read event. A relay "done" without the stamp is still drained.
    func testDrainSkipsHandledDrop() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let m = String(repeating: "A", count: 400)
        let r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        XCTAssertEqual(r.banner, .dropped)
        XCTAssertTrue(r.handled)
        func events() throws -> Int64 { try x.core.store.history().filter { $0.event == .couldNotRead }.map { $0.count }.reduce(0, +) }
        XCTAssertEqual(try events(), 1)
        let info = try XCTUnwrap(r.banner).userInfo(m: m, key: key, handled: r.handled)
        var drained = await x.core.drainDelivered([info])
        XCTAssertEqual(drained, [])
        XCTAssertEqual(try events(), 1)
        // forged: "done" without the stamp, or the stamp of an unmarked banner with "done" added
        var forged = try XCTUnwrap(r.banner).userInfo(m: m, key: key)
        forged["done"] = "1"
        drained = await x.core.drainDelivered([["m": m, "done": "1", "tap": "history"], forged])
        XCTAssertEqual(drained, [0, 1])
        XCTAssertEqual(try events(), 3)
    }

    /// I311: the delivered drain skips "m" only under a valid NSE stamp; a relay rowid or a
    /// stamp under another key does not skip it.
    func testDrainSkipsOnlyStamped() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        for t in ["one", "two", "three"] { _ = try await n.core.send(t, as: .text, to: [x.id], allCount: 1) }
        let ms = w.take(x.id)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let r = await NSEFlow.handle(m: ms[0], loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        let stamped = try XCTUnwrap(r.banner).userInfo(m: ms[0], key: key)
        let fakeRowid: [AnyHashable: Any] = ["m": ms[1], "rowid": NSNumber(value: try XCTUnwrap(r.rowid)), "tap": "detail"]
        let otherKey = Banner(body: "x", locKey: nil, category: .text, threadId: "t", rowid: 99, tap: .detail)
            .userInfo(m: ms[2], key: Data(count: 32))
        let drained = await x.core.drainDelivered([stamped, fakeRowid, otherKey, ["tap": "none"]])
        XCTAssertEqual(drained, [1, 2])
        let texts = try x.core.store.history().map { $0.content }
        for t in ["one", "two", "three"] { XCTAssertEqual(texts.filter { $0 == t }.count, 1, t) }
    }
}
