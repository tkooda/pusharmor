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
        let got = await x.core.drainLockedInbox(inbox).count
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
        // one "m" is one push: the second copy is removed, not run again (I328)
        XCTAssertEqual(try events(), 2)
        XCTAssertEqual(TapStamp.drainM(forged, key: key), m)
    }

    /// I313: a push the NSE put in the locked inbox is also delivered unmarked; the delivered
    /// drain skips an "m" the locked-inbox drain already ran, so an unreadable one gives one event.
    func testLockedUnreadableOneEvent() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let m = String(repeating: "A", count: 400)
        let r = await NSEFlow.handle(m: m, loadKeys: { throw KeyLoadError.beforeFirstUnlock }, openCore: { _ in nil }, inbox: inbox,
                                     nowMs: 1, budgetLeft: { 30 })
        XCTAssertEqual(r.banner, .locked)
        let info = try XCTUnwrap(r.banner).userInfo(m: m, key: key, handled: r.handled)
        let locked = await x.core.drainLockedInbox(inbox)
        let drained = await x.core.drainDelivered([info], skip: locked.ms)
        XCTAssertEqual(drained, [0])
        let events = try x.core.store.history().filter { $0.event == .couldNotRead }.map { $0.count }.reduce(0, +)
        XCTAssertEqual(events, 1)
        inbox.removeAll()
    }

    /// I315: a thrown store error (here SQLITE_BUSY while another connection writes) is not a
    /// final verdict: the NSE leaves the push unmarked and the delivered drain stores it.
    func testNSEFaultLeavesPushForDrain() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("kept", as: .text, to: [x.id], allCount: 1)
        let m = try XCTUnwrap(w.take(x.id).first)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let other = try DB(path: x.path)
        try other.exec("BEGIN IMMEDIATE")
        let r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        try other.exec("ROLLBACK")
        XCTAssertEqual(r.banner, .dropped)
        XCTAssertFalse(r.handled)
        let info = try XCTUnwrap(r.banner).userInfo(m: m, key: key, handled: r.handled)
        let drained = await x.core.drainDelivered([info])
        XCTAssertEqual(drained, [0])
        XCTAssertEqual(try x.core.store.history().filter { $0.content == "kept" }.count, 1)
    }

    /// I329: the NSE keeps a final drop's content (stamped "done") for time expiry, so the app
    /// runs that push no second time; a fault is never kept, and its expiry "m" is drained.
    func testNSEExpiryAfterFinalDropOneEvent() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        func events() throws -> Int64 { try x.core.store.history().filter { $0.event == .couldNotRead }.map { $0.count }.reduce(0, +) }
        // final drop: kept for expiry; that content is skipped by the drain
        let bad = String(repeating: "A", count: 400)
        var kept: [ReceiveResult] = []
        _ = await NSEFlow.handle(m: bad, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1,
                                 budgetLeft: { 30 }, onReceived: { kept.append($0) })
        XCTAssertEqual(kept.count, 1)
        let k = try XCTUnwrap(kept.first)
        let expiry = try XCTUnwrap(k.banner).userInfo(m: bad, key: key, handled: k.handled)
        XCTAssertNil(TapStamp.drainM(expiry, key: key))
        var drained = await x.core.drainDelivered([expiry])
        XCTAssertEqual(drained, [])
        XCTAssertEqual(try events(), 1)
        // fault (busy store): nothing kept; the expiry content is only "m" and the drain stores it
        _ = try await n.core.send("kept", as: .text, to: [x.id], allCount: 1)
        let m = try XCTUnwrap(w.take(x.id).first)
        let other = try DB(path: x.path)
        try other.exec("BEGIN IMMEDIATE")
        kept = []
        _ = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 2,
                                 budgetLeft: { 30 }, onReceived: { kept.append($0) })
        try other.exec("ROLLBACK")
        XCTAssertTrue(kept.isEmpty)
        drained = await x.core.drainDelivered([Banner.expiryUserInfo(m: m)])
        XCTAssertEqual(drained, [0])
        XCTAssertEqual(try x.core.store.history().filter { $0.content == "kept" }.count, 1)
        XCTAssertEqual(try events(), 1)
        inbox.removeAll()
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
    /// I323: a transient fault (here a me() read failure) is not a final drop: it writes no
    /// "could not read" event; the delivered drain then stores the message.
    func testFaultWritesNoEvent() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("kept", as: .text, to: [x.id], allCount: 1)
        let m = try XCTUnwrap(w.take(x.id).first)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let other = try DB(path: x.path)
        try other.exec("ALTER TABLE me RENAME TO me_off")
        let r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        try other.exec("ALTER TABLE me_off RENAME TO me")
        XCTAssertTrue(r.fault)
        XCTAssertFalse(r.handled)
        let info = try XCTUnwrap(r.banner).userInfo(m: m, key: key, handled: r.handled)
        let drained = await x.core.drainDelivered([info])
        XCTAssertEqual(drained, [0])
        let h = try x.core.store.history()
        XCTAssertEqual(h.filter { $0.content == "kept" }.count, 1)
        XCTAssertEqual(h.filter { $0.event == .couldNotRead }.count, 0)
    }
    /// I324: a drop whose event write fails (here SQLITE_BUSY) is not final: the NSE leaves the
    /// push unmarked and the delivered drain writes the one event.
    func testDropEventWriteFaultRetried() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let m = "not-a-message!"
        let other = try DB(path: x.path)
        try other.exec("BEGIN IMMEDIATE")
        let r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        try other.exec("ROLLBACK")
        XCTAssertTrue(r.fault)
        XCTAssertFalse(r.handled)
        let info = try XCTUnwrap(r.banner).userInfo(m: m, key: key, handled: r.handled)
        let drained = await x.core.drainDelivered([info])
        XCTAssertEqual(drained, [0])
        XCTAssertEqual(try x.core.store.history().filter { $0.event == .couldNotRead }.count, 1)
    }
    /// I322: a delivered push whose app-side receive faults is not removed; the next drain
    /// stores it once and only then returns its index.
    func testDeliveredFaultKeepsPush() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("kept", as: .text, to: [x.id], allCount: 1)
        let m = try XCTUnwrap(w.take(x.id).first)
        let info: [AnyHashable: Any] = ["m": m, "tap": "history"]
        let other = try DB(path: x.path)
        try other.exec("ALTER TABLE me RENAME TO me_off")
        var drained = await x.core.drainDelivered([info])
        try other.exec("ALTER TABLE me_off RENAME TO me")
        XCTAssertEqual(drained, [])
        drained = await x.core.drainDelivered([info])
        XCTAssertEqual(drained, [0])
        let h = try x.core.store.history()
        XCTAssertEqual(h.filter { $0.content == "kept" }.count, 1)
        XCTAssertEqual(h.filter { $0.event == .couldNotRead }.count, 0)
    }
    /// I321: a locked-inbox push whose app-side receive faults keeps its file and is held: the
    /// delivered drain neither runs nor removes it; the next locked drain stores it once.
    func testLockedFaultKeepsFile() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("kept", as: .text, to: [x.id], allCount: 1)
        let m = try XCTUnwrap(w.take(x.id).first)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let key = try TapStamp.key(x.core.store)
        let r = await NSEFlow.handle(m: m, loadKeys: { throw KeyLoadError.beforeFirstUnlock }, openCore: { _ in nil }, inbox: inbox,
                                     nowMs: 1, budgetLeft: { 30 })
        let info = try XCTUnwrap(r.banner).userInfo(m: m, key: key, handled: r.handled)
        let other = try DB(path: x.path)
        try other.exec("ALTER TABLE me RENAME TO me_off")
        var locked = await x.core.drainLockedInbox(inbox)
        try other.exec("ALTER TABLE me_off RENAME TO me")
        XCTAssertEqual(inbox.files().count, 1)
        XCTAssertFalse(locked.ms.contains(m))
        XCTAssertTrue(locked.held.contains(m))
        var drained = await x.core.drainDelivered([info], skip: locked.ms, held: locked.held)
        XCTAssertEqual(drained, [])
        XCTAssertEqual(try x.core.store.history().filter { $0.content == "kept" }.count, 0)
        locked = await x.core.drainLockedInbox(inbox)
        XCTAssertEqual(locked.count, 1)
        XCTAssertEqual(inbox.files().count, 0)
        drained = await x.core.drainDelivered([info], skip: locked.ms, held: locked.held)
        XCTAssertEqual(drained, [0])
        let h = try x.core.store.history()
        XCTAssertEqual(h.filter { $0.content == "kept" }.count, 1)
        XCTAssertEqual(h.filter { $0.event == .couldNotRead }.count, 0)
        inbox.removeAll()
    }
    /// I325: a tapped notification is gone once tapped; a fault in its app-side receive keeps
    /// "m" in the locked inbox, and the next locked drain stores it once.
    func testTapFaultKeepsPush() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("kept", as: .text, to: [x.id], allCount: 1)
        let m = try XCTUnwrap(w.take(x.id).first)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let other = try DB(path: x.path)
        try other.exec("ALTER TABLE me RENAME TO me_off")
        let r = await x.core.receiveTapped(m, inbox: inbox)
        try other.exec("ALTER TABLE me_off RENAME TO me")
        XCTAssertTrue(r.fault)
        XCTAssertEqual(inbox.files().count, 1)
        let locked = await x.core.drainLockedInbox(inbox)
        XCTAssertEqual(locked.count, 1)
        XCTAssertEqual(inbox.files().count, 0)
        let h = try x.core.store.history()
        XCTAssertEqual(h.filter { $0.content == "kept" }.count, 1)
        XCTAssertEqual(h.filter { $0.event == .couldNotRead }.count, 0)
        inbox.removeAll()
    }
    /// I327: an NSE fault leaves a copy of "m" in the locked inbox; a tap that then reaches a
    /// final drop removes that copy, so the next locked drain writes no second event.
    func testTapDropRemovesNSECopy() async throws {
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let m = String(repeating: "A", count: 120)   // strict b64url that does not open: a final drop
        let other = try DB(path: x.path)
        try other.exec("BEGIN IMMEDIATE")
        let r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        try other.exec("ROLLBACK")
        XCTAssertTrue(r.fault)
        XCTAssertEqual(inbox.files().count, 1)
        let t = await x.core.receiveTapped(m, inbox: inbox)
        XCTAssertFalse(t.fault)
        XCTAssertEqual(inbox.files().count, 0)
        _ = await x.core.drainLockedInbox(inbox)
        let ev = try x.core.store.history().filter { $0.event == .couldNotRead }
        XCTAssertEqual(ev.count, 1)
        XCTAssertEqual(ev.first?.count, 1)
        inbox.removeAll()
    }
    /// I327: a tap fault while the NSE copy exists writes no second file with the same "m",
    /// and one locked drain runs each "m" at most once (two files, one event).
    func testTapFaultNoSecondCopy() async throws {
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let m = String(repeating: "A", count: 120)   // strict b64url that does not open: a final drop
        let other = try DB(path: x.path)
        try other.exec("BEGIN IMMEDIATE")
        let r = await NSEFlow.handle(m: m, loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        let t = await x.core.receiveTapped(m, inbox: inbox)
        try other.exec("ROLLBACK")
        XCTAssertTrue(r.fault)
        XCTAssertTrue(t.fault)
        XCTAssertEqual(inbox.files().count, 1)
        try inbox.write(m, nowMs: 2)
        XCTAssertEqual(inbox.files().count, 2)
        _ = await x.core.drainLockedInbox(inbox)
        XCTAssertEqual(inbox.files().count, 0)
        let ev = try x.core.store.history().filter { $0.event == .couldNotRead }
        XCTAssertEqual(ev.count, 1)
        XCTAssertEqual(ev.first?.count, 1)
        inbox.removeAll()
    }
    /// I326: an NSE fault (store error, or the DB does not open) keeps "m" in the locked inbox,
    /// so a notification the user clears is not the only copy; the next locked drain stores it.
    func testNSEFaultKeepsPushInInbox() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        _ = try await n.core.send("one", as: .text, to: [x.id], allCount: 1)
        _ = try await n.core.send("two", as: .text, to: [x.id], allCount: 1)
        let ms = w.take(x.id)
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let other = try DB(path: x.path)
        try other.exec("ALTER TABLE me RENAME TO me_off")
        let r = await NSEFlow.handle(m: ms[0], loadKeys: { x.keys }, openCore: { _ in x.core }, inbox: inbox, nowMs: 1, budgetLeft: { 30 })
        try other.exec("ALTER TABLE me_off RENAME TO me")
        XCTAssertTrue(r.fault)
        let r2 = await NSEFlow.handle(m: ms[1], loadKeys: { x.keys }, openCore: { _ in nil }, inbox: inbox, nowMs: 2, budgetLeft: { 30 })
        XCTAssertFalse(r2.handled)
        XCTAssertEqual(inbox.files().count, 2)
        let locked = await x.core.drainLockedInbox(inbox)
        XCTAssertEqual(locked.count, 2)
        XCTAssertEqual(inbox.files().count, 0)
        let h = try x.core.store.history()
        for t in ["one", "two"] { XCTAssertEqual(h.filter { $0.content == t }.count, 1, t) }
        XCTAssertEqual(h.filter { $0.event == .couldNotRead }.count, 0)
        inbox.removeAll()
    }
    /// I328: a tap receive and the foreground locked drain on the same "m" at once write one
    /// event. A held write lock parks both mid-receive until both have started.
    func testTapAndLockedDrainAtOnceOneEvent() async throws {
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let inbox = LockedInbox(dir: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pa-nse-\(UUID().uuidString)"))
        let m = String(repeating: "A", count: 120)   // strict b64url that does not open: a final drop
        try inbox.write(m, nowMs: 1)
        let other = try DB(path: x.path)
        try other.exec("BEGIN IMMEDIATE")
        let core = x.core
        async let locked = core.drainLockedInbox(inbox)
        async let tap = core.receiveTapped(m, inbox: inbox)
        try await Task.sleep(nanoseconds: 300_000_000)
        try other.exec("ROLLBACK")
        let (l, t) = await (locked, tap)
        XCTAssertTrue(l.held.isEmpty)
        XCTAssertFalse(t.fault)
        XCTAssertEqual(inbox.files().count, 0)
        let ev = try x.core.store.history().filter { $0.event == .couldNotRead }
        XCTAssertEqual(ev.count, 1)
        XCTAssertEqual(ev.first?.count, 1)
        inbox.removeAll()
    }
}
