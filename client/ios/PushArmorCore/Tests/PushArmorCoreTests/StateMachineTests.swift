import XCTest
@testable import PushArmorCore

/// Per-platform state-machine tests (component-ci section 3 and ios section 13) over two or
/// more devices and a fake Worker.
final class StateMachineTests: XCTestCase {
    var w: FakeWorker!
    var clock: TestClock!

    override func setUp() {
        w = FakeWorker()
        clock = TestClock()
    }

    func dev(_ name: String) throws -> Device { try Device(worker: w, clock: clock, name: name) }

    func pairToShown(_ n: Device, _ x: Device) async throws { try await Scenario.pairToShown(w, n, x) }
    func pairFully(_ n: Device, _ x: Device) async throws { try await Scenario.pairFully(w, n, x) }

    func testFullPairingAndSend() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        // send N -> X
        await n.core.fetchPeers(force: true)
        XCTAssertEqual(try n.core.allSet().map { $0.id }, [x.id])
        let rep = try await n.core.send("https://example.com/a", as: .url, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.toast, "Sent to 1 of 1 device")
        XCTAssertEqual(S.sentToOne("Laptop"), "Sent to \"Laptop\"")
        let pushed = w.take(x.id)
        XCTAssertEqual(pushed.count, 1)
        let r = await x.core.receive(pushed[0], mode: .nse)
        XCTAssertEqual(r.banner?.body, "https://example.com/a")
        XCTAssertEqual(r.banner?.category, .url)
        XCTAssertTrue(r.newMessage)
        // a Worker retry duplicate re-presents the same row, no new row
        let again = await x.core.receive(pushed[0], mode: .nse)
        XCTAssertEqual(again.rowid, r.rowid)
        XCTAssertEqual(try x.core.store.history().filter { $0.type == "url" }.count, 1)
        // the outgoing History row carries the results
        XCTAssertEqual(try n.core.store.history().first?.dir, .outgoing)
    }

    func testReplayOfMessageWithoutHistoryIsInvalid() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        _ = try await n.core.send("hello", as: .text, to: [x.id], allCount: 1)
        let m = w.take(x.id)[0]
        _ = await x.core.receive(m, mode: .nse)
        try x.core.store.db.exec("DELETE FROM history WHERE type = 'text'")
        let r = await x.core.receive(m, mode: .nse)
        XCTAssertEqual(r.banner, .invalid)
        XCTAssertEqual(try x.core.store.history().first?.event, .invalid)
        XCTAssertEqual(try x.core.store.history().first?.peerId, n.id.text)   // named after a verified signature
    }

    func testControlSeenNAndReturnedCNeverInvalid() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairToShown(n, x)
        let v4 = await x.core.approve(n.id)
        XCTAssertEqual(v4, .stored)
        let v5 = await n.core.approve(x.id)
        XCTAssertEqual(v5, .completed)
        let pushed = w.take(x.id)
        let a = await x.core.receive(pushed[0], mode: .nse)
        XCTAssertEqual(a.banner?.body, S.approved("Ndev"))
        let dup = await x.core.receive(pushed[0], mode: .nse)
        XCTAssertEqual(dup.banner?.body, S.approved("Ndev"))       // same notice re-presented
        XCTAssertFalse(try x.core.store.history().contains { $0.event == .invalid })
        // a re-sent approve whose returned c is already seen: silent no-op
        try x.core.store.db.exec("UPDATE peers SET approve_verified = 0")
        _ = await x.core.postApprove(n.id, fresh: false)
        XCTAssertFalse(try x.core.store.history().contains { $0.event == .invalid })
    }

    func testCounterReservedByTwoProcessesIsDistinct() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        let start = try n.core.store.peer(x.id)!.lastN
        let path = n.path
        let threads = 4, per = 25
        let group = DispatchGroup()
        let lock = NSLock()
        var got: [UInt64] = []
        for _ in 0 ..< threads {
            group.enter()
            Thread.detachNewThread {
                let s = try! Store(path: path)   // a second connection, as another process would open
                var mine: [UInt64] = []
                for _ in 0 ..< per { mine.append(try! s.reserveCounter(x.id)) }
                lock.lock(); got += mine; lock.unlock()
                group.leave()
            }
        }
        group.wait()
        XCTAssertEqual(Set(got).count, threads * per)
        XCTAssertEqual(got.max(), UInt64(start) + UInt64(threads * per))
    }

    func testWipeResetsPerPeerRulingState() throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try n.core.store.db.write {
            try n.core.store.db.exec("""
                INSERT INTO peers (id, state, approve_verified, approve_verified_at, logged_out, logout_n, name, name_n)
                VALUES ('\(x.id.text)', 'approved', 1, 5, 1, 7, 'Xdev', 3)
                ON CONFLICT(id) DO UPDATE SET state = 'approved', approve_verified = 1, approve_verified_at = 5,
                  logged_out = 1, logout_n = 7, name = 'Xdev', name_n = 3
                """)
        }
        n.core.selfRemoved()
        let p = try n.core.store.peer(x.id)!
        XCTAssertEqual(p.state, .unruled)
        XCTAssertFalse(p.approveVerified)
        XCTAssertNil(p.approveVerifiedAt)
        XCTAssertFalse(p.loggedOut)
        XCTAssertEqual(p.logoutN, 0)
        XCTAssertNil(p.name)
        XCTAssertEqual(p.nameN, 0)
    }

    func testRegisterRetriesOnceOnClockSkew() async throws {
        let n = try dev("Ndev")
        w.script("POST", "/v1/peers", 401, "{\"error\":\"clock skew\"}")
        w.script("POST", "/v1/peers", 409, "{\"error\":\"id collision\"}")
        let r = await n.core.register(ticket: "t", push: nil)
        guard case .idCollision = r else { return XCTFail("expected the retried reply, got \(r)") }
        XCTAssertEqual(w.count("POST", "/v1/peers"), 2)
    }

    func testClockSkewRetryReservesNewN() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        let before = try n.core.store.peer(x.id)!.lastN
        w.script("POST", "/v1/send", 401, "{\"error\":\"clock skew\"}")
        let rep = try await n.core.send("hi", as: .text, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.sent, 1)
        XCTAssertEqual(try n.core.store.peer(x.id)!.lastN, before + 2)  // discarded n, then a NEW n
        let r = await x.drainInbox(w)
        XCTAssertTrue(r[0].newMessage)
        let row = try x.core.store.history().first { $0.type == "text" }!
        XCTAssertEqual(row.n, before + 2)
        // a second 401 "clock skew" stops
        w.script("POST", "/v1/send", 401, "{\"error\":\"clock skew\"}")
        w.script("POST", "/v1/send", 401, "{\"error\":\"clock skew\"}")
        do {
            _ = try await n.core.send("hi", as: .text, to: [x.id], allCount: 1)
            XCTFail("expected clock off")
        } catch {
            XCTAssertEqual(error as? Core.SendError, .clockOff)
        }
    }

    func testRetryPolicy() {
        XCTAssertEqual(RetryPolicy.delay(retriesDone: 0, status: nil, retryAfter: nil, elapsed: 0), 0.5)
        XCTAssertEqual(RetryPolicy.delay(retriesDone: 1, status: 503, retryAfter: nil, elapsed: 0.5), 1.5)
        XCTAssertEqual(RetryPolicy.delay(retriesDone: 2, status: 429, retryAfter: nil, elapsed: 2), 3)
        XCTAssertNil(RetryPolicy.delay(retriesDone: 3, status: 503, retryAfter: nil, elapsed: 5))
        XCTAssertNil(RetryPolicy.delay(retriesDone: 0, status: 502, retryAfter: nil, elapsed: 0))
        XCTAssertNil(RetryPolicy.delay(retriesDone: 0, status: 400, retryAfter: nil, elapsed: 0))
        XCTAssertEqual(RetryPolicy.delay(retriesDone: 0, status: 429, retryAfter: 5, elapsed: 1), 5)
        XCTAssertNil(RetryPolicy.delay(retriesDone: 0, status: 429, retryAfter: 60, elapsed: 0))   // countdown instead
    }

    func testAllowReconcile() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev"), o = try dev("Odev")
        try await pairFully(n, x)
        // orphan o (no pin) and pinned x in the allow set
        try n.core.store.allowAdd([o.id.text, x.id.text])
        w.script("POST", "/v1/deny/" + o.id.text, 429, "{\"error\":\"rate limited\",\"retry_after\":60}")
        await n.core.allowReconcile()
        XCTAssertTrue(try n.core.store.allowSet().contains(o.id.text))  // kept on 429
        await n.core.allowReconcile()
        XCTAssertFalse(try n.core.store.allowSet().contains(o.id.text))
        XCTAssertTrue(try n.core.store.allowSet().contains(x.id.text))  // a pinned id is never withdrawn
        XCTAssertEqual(w.count("POST", "/v1/deny/" + x.id.text), 0)
        // 400 also removes the id
        try n.core.store.allowAdd([o.id.text])
        w.script("POST", "/v1/deny/" + o.id.text, 400, "{\"error\":\"bad request\"}")
        await n.core.allowReconcile()
        XCTAssertFalse(try n.core.store.allowSet().contains(o.id.text))
    }

    /// I285: Deny on an unpinned row posts a deny (zero pairing id) so the Worker sets deny[X].
    func testDenyUnpinnedRowPostsDeny() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        XCTAssertFalse(try n.core.store.peer(x.id)!.pinned)
        _ = await n.core.deny(x.id)
        XCTAssertEqual(w.count("POST", "/v1/deny/" + x.id.text), 1)
        XCTAssertEqual(w.rows[n.id.text]!.deny[x.id.text], true)
        XCTAssertEqual(try n.core.store.peer(x.id)!.state, .denied)
    }

    func testMessagesMissingWithdrawsThenRetriesOnce() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev"), o = try dev("Odev")
        try await pairFully(n, x)
        // the Worker still has o in n's allow (a lost reply), unknown to the local set
        w.rows[n.id.text]!.allow[o.id.text] = true
        let out = try await n.core.logout()
        XCTAssertEqual(out.reply?.status, 200)
        XCTAssertEqual(w.count("POST", "/v1/deny/" + o.id.text), 1)       // withdraw
        XCTAssertEqual(w.count("POST", "/v1/peers/" + n.id.text + "/logout"), 2)  // refused once, retried once
        XCTAssertTrue(try n.core.store.me().loggedOut)
        // a withdraw sent while logged out succeeds
        try n.core.store.allowAdd([o.id.text])
        await n.core.allowReconcile()
        XCTAssertFalse(try n.core.store.allowSet().contains(o.id.text))
    }

    /// Q368: Log out is local at once; a failed relay server call stays pending and is retried.
    func testLogoutLocalFirstThenPendingRetry() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        let path = "/v1/peers/" + n.id.text + "/logout"
        try n.core.logoutLocal()
        XCTAssertTrue(try n.core.store.me().loggedOut)
        XCTAssertTrue(n.core.logoutPending)
        w.offline = true
        await n.core.retryPendingLogout()
        XCTAssertTrue(try n.core.store.me().loggedOut)            // still logged out here
        XCTAssertTrue(n.core.logoutPending)                       // kept for the next try
        XCTAssertFalse(w.rows[n.id.text]!.loggedOut)
        w.offline = false
        w.script("POST", path, 503, "{\"error\":\"busy\"}")
        w.script("POST", path, 503, "{\"error\":\"busy\"}")
        w.script("POST", path, 503, "{\"error\":\"busy\"}")
        w.script("POST", path, 503, "{\"error\":\"busy\"}")
        await n.core.retryPendingLogout()
        XCTAssertTrue(n.core.logoutPending)                       // 5xx: kept
        await n.core.retryPendingLogout()
        XCTAssertFalse(n.core.logoutPending)
        XCTAssertTrue(w.rows[n.id.text]!.loggedOut)
        XCTAssertTrue(try n.core.store.me().loggedOut)
        let sent = w.count("POST", path)
        await n.core.retryPendingLogout()                         // nothing pending: no call
        XCTAssertEqual(w.count("POST", path), sent)
    }

    /// Q368: a pending logout is dropped once this device logs in again.
    func testPendingLogoutDroppedAfterLoggingInAgain() async throws {
        let n = try dev("Ndev")
        try n.core.logoutLocal()
        try n.core.store.setMe("logged_out", .int(0))
        await n.core.retryPendingLogout()
        XCTAssertFalse(n.core.logoutPending)
        XCTAssertEqual(w.count("POST", "/v1/peers/" + n.id.text + "/logout"), 0)
    }

    func testStaleAllowIdPlusOpenNEntryWithdrawnPauseSucceeds() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        _ = try await n.core.startPair(x.id)                    // open N entry, no pin
        w.rows[n.id.text]!.allow[x.id.text] = true               // stale allow on the Worker
        try n.core.store.allowAdd([x.id.text])
        await n.core.allowReconcile()
        XCTAssertNil(w.rows[n.id.text]!.allow[x.id.text])
        let out = try await n.core.logout()
        XCTAssertEqual(out.reply?.status, 200)
    }

    func testApproveLostThenRefetchOnOpenAndRefresh() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairToShown(n, x)
        let v6 = await n.core.approve(x.id)
        XCTAssertEqual(v6, .stored)
        let v7 = await x.core.approve(n.id)
        XCTAssertEqual(v7, .completed)
        _ = w.take(n.id)                                         // X's approve push is lost
        XCTAssertFalse(try n.core.store.peer(x.id)!.approveVerified)   // "Waiting for X"
        let sentBefore = try n.core.store.peer(x.id)!.approveC
        w.script("POST", "/v1/approve/" + x.id.text, 429, "{\"error\":\"rate limited\",\"retry_after\":60}")
        await n.core.resendWaitingApproves()                     // silent on 429
        XCTAssertFalse(try n.core.store.peer(x.id)!.approveVerified)
        await n.core.appOpen(push: nil)                          // same bytes, the Worker returns X's stored approve
        XCTAssertEqual(try n.core.store.peer(x.id)!.approveC, sentBefore)
        XCTAssertTrue(try n.core.store.peer(x.id)!.approveVerified)
        XCTAssertNil(try n.core.store.pairing(x.id))
        // X receives the relayed copy as a seen-n duplicate: no Invalid
        await x.drainInbox(w)
        XCTAssertFalse(try x.core.store.history().contains { $0.event == .invalid })
    }

    func testRenameWhileWaitingBuildsFreshApprove() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairToShown(n, x)
        let v8 = await n.core.approve(x.id)
        XCTAssertEqual(v8, .stored)
        let first = try n.core.store.peer(x.id)!.approveC
        _ = try await n.core.rename("Renamed")
        await n.core.resendWaitingApproves()
        let p = try n.core.store.peer(x.id)!
        XCTAssertNotEqual(p.approveC, first)
        XCTAssertEqual(p.approveNameRev, try n.core.store.me().nameRev)
        let v9 = await x.core.approve(n.id)
        XCTAssertEqual(v9, .completed)
        XCTAssertEqual(try x.core.store.peer(n.id)!.name, "Renamed")
    }

    func testPairingStatePersistsAcrossRestartAndTwoOpenAtOnce() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev"), o = try dev("Odev")
        await n.core.fetchPeers(force: true)
        await x.core.fetchPeers(force: true)
        await o.core.fetchPeers(force: true)
        _ = try await n.core.startPair(x.id)
        clock.now += 3600
        _ = try await n.core.startPair(o.id)
        await x.drainInbox(w)
        await o.drainInbox(w)
        await n.drainInbox(w)
        await x.drainInbox(w)
        await o.drainInbox(w)
        let fx = try n.core.store.peer(x.id)!.fingerprint, fo = try n.core.store.peer(o.id)!.fingerprint
        XCTAssertNotNil(fx)
        XCTAssertNotNil(fo)
        XCTAssertNotEqual(try n.core.store.peer(x.id)!.pairingId, try n.core.store.peer(o.id)!.pairingId)
        let ex = try n.core.store.pairing(x.id)!, eo = try n.core.store.pairing(o.id)!
        XCTAssertEqual(eo.startedAt - ex.startedAt, 3600)
        // restart at day 13: a new store connection reads the same state
        clock.now = ex.startedAt + 13 * 86400
        let reopened = try Store(path: n.path)
        let e2 = try reopened.pairing(x.id)!
        XCTAssertEqual(e2, ex)
        XCTAssertEqual(Pairing.countdown(startedAt: e2.startedAt, now: clock.now), "1 day")
        XCTAssertEqual(Pairing.countdown(startedAt: eo.startedAt, now: clock.now), "1 day")
        clock.now = ex.startedAt + 14 * 86400 - 1800
        XCTAssertEqual(Pairing.countdown(startedAt: e2.startedAt, now: clock.now), "30 minutes")
        XCTAssertEqual(Pairing.countdown(startedAt: eo.startedAt, now: clock.now), "1 hour")
    }

    func testDuplicateCommitResendsOnlyWhenAuthorized() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        await x.core.fetchPeers(force: true)
        // cap used up on X: the commit is prompted
        try x.core.store.setSetting("pair_cap", (0 ..< 10).map { String(clock.now - Int64($0) * 60) }.joined(separator: ","))
        _ = try await n.core.startPair(x.id)
        let commit = w.take(x.id)[0]
        _ = await x.core.receive(commit, mode: .nse)
        XCTAssertEqual(try x.core.store.pairing(n.id)?.state, .prompted)
        XCTAssertEqual(w.inbox[n.id.text]?.count ?? 0, 0)
        _ = await x.core.receive(commit, mode: .nse)                    // replayed commit: sends nothing (I229)
        XCTAssertEqual(w.inbox[n.id.text]?.count ?? 0, 0)
        let rX = try x.core.store.pairing(n.id)!.r
        _ = await x.core.tapReply(n.id)                                 // tapped: not counted
        XCTAssertEqual(try x.core.store.capTimestamps().count, 10)
        XCTAssertEqual(w.take(n.id).count, 1)
        _ = await x.core.receive(commit, mode: .nse)                    // now authorized: same r_X re-sent
        let again = w.take(n.id)
        XCTAssertEqual(again.count, 1)
        XCTAssertEqual(try x.core.store.pairing(n.id)!.r, rX)
        let parsed = try PairMessage.open(again[0], me: n.id, key: n.keys.decryptor)
        guard case .reply(_, _, let r) = parsed.body else { return XCTFail() }
        XCTAssertEqual(r, rX)
    }

    func testFailedReplyRetriedOnOpenWithSameRX() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        await x.core.fetchPeers(force: true)
        _ = try await n.core.startPair(x.id)
        let commit = w.take(x.id)[0]
        w.offline = true
        _ = await x.core.receive(commit, mode: .nse)
        w.offline = false
        let e = try x.core.store.pairing(n.id)!
        XCTAssertTrue(e.authorized)
        XCTAssertTrue(e.unsent)
        XCTAssertEqual(e.state, .prompted)
        XCTAssertEqual(try x.core.store.capTimestamps().count, 1)       // counted when persisted
        await x.core.retryUnsentReplies()
        XCTAssertEqual(try x.core.store.pairing(n.id)!.state, .replied)
        XCTAssertEqual(try x.core.store.pairing(n.id)!.r, e.r)
        XCTAssertEqual(w.take(n.id).count, 1)
    }

    func testPairRetryWaitsForNotBefore() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        w.script("POST", "/v1/pair/", 429, "{\"error\":\"rate limited\",\"retry_after\":60}")
        let r = try await n.core.startPair(x.id)
        XCTAssertEqual(r, .rateLimited(clock.now + 60))
        clock.now += 30
        let greyed = await n.core.sendAgain(x.id)        // greyed 60 s after the last send, whatever its result
        XCTAssertNil(greyed)
        clock.now += 31
        try n.core.store.db.exec("UPDATE pairing SET last_send_at = 0, not_before = ?", [.int(clock.now + 30)])
        let v10 = await n.core.sendAgain(x.id)
        XCTAssertEqual(v10, .waiting(clock.now + 30))
        clock.now += 30
        let v11 = await n.core.sendAgain(x.id)
        XCTAssertEqual(v11, .sent)
    }

    func testCapTwoConcurrentCommitsAtCapMinusOne() async throws {
        let x = try dev("Xdev"), a = try dev("Adev"), b = try dev("Bdev")
        await x.core.fetchPeers(force: true)
        await a.core.fetchPeers(force: true)
        await b.core.fetchPeers(force: true)
        try x.core.store.setSetting("pair_cap", (0 ..< 9).map { String(clock.now - Int64($0) * 60) }.joined(separator: ","))
        _ = try await a.core.startPair(x.id)
        _ = try await b.core.startPair(x.id)
        let ms = w.take(x.id)
        // two NSE processes on the same store file
        let x2 = Core(store: try Store(path: x.path), api: x.core.api, keys: x.keys, clock: { [clock] in clock!.now })
        async let r1 = x.core.receive(ms[0], mode: .nse)
        async let r2 = x2.receive(ms[1], mode: .nse)
        _ = await (r1, r2)
        let states = try x.core.store.pairings().map { $0.authorized }
        XCTAssertEqual(states.filter { $0 }.count, 1)
        XCTAssertEqual(states.filter { !$0 }.count, 1)
        XCTAssertEqual(try x.core.store.capTimestamps().count, 10)
    }

    func testCrossingLowerIdStaysN() async throws {
        let a = try dev("Adev"), b = try dev("Bdev")
        await a.core.fetchPeers(force: true)
        await b.core.fetchPeers(force: true)
        _ = try await a.core.startPair(b.id)
        _ = try await b.core.startPair(a.id)
        let low = a.id < b.id ? a : b, high = a.id < b.id ? b : a
        let toLow = await low.drainInbox(w)
        XCTAssertEqual(toLow.first?.banner?.body, S.pairCrossing(PeerLabel.label(try low.core.store.peer(high.id))))
        await high.drainInbox(w)                                   // wipes its N entry, replies as X
        XCTAssertEqual(try high.core.store.pairing(low.id)?.role, .x)
        await low.drainInbox(w)                                    // reply -> open
        await high.drainInbox(w)
        XCTAssertEqual(try low.core.store.pairing(high.id)?.role, .n)
        XCTAssertEqual(try low.core.store.pairing(high.id)?.state, .shown)
        XCTAssertEqual(try high.core.store.pairing(low.id)?.state, .shown)
        XCTAssertEqual(try low.core.store.peer(high.id)!.fingerprint, try high.core.store.peer(low.id)!.fingerprint)
        XCTAssertEqual(try high.core.store.capTimestamps().count, 0)    // tapped reply, not counted
    }

    func testRule3dHalfStateNoticeAndCancelPairing() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        // a commit from a pinned, fully paired id: plain drop, nothing changes
        let lastN = try x.core.store.peer(n.id)!.lastN
        try n.core.store.dropPin(x.id)                                     // N lost its half, pairs again
        try n.core.store.db.exec("UPDATE peers SET state = 'unruled'")
        _ = try await n.core.startPair(x.id)
        let commit = w.take(x.id)[0]
        let r = await x.core.receive(commit, mode: .nse)
        XCTAssertEqual(r.banner, .dropped)
        XCTAssertNil(try x.core.store.pairing(n.id))
        XCTAssertEqual(try x.core.store.peer(n.id)!.lastN, lastN)
        XCTAssertEqual(try x.core.store.capTimestamps().count, 1)          // only the first pairing's reply
        // X sees approves_me false in a GET fetched after the approve verified: half state
        w.rows[n.id.text]!.allow = [:]
        clock.now += 10
        await x.core.fetchPeers(force: true)
        XCTAssertTrue(try x.core.store.peer(n.id)!.notPairedOnPeer)
        let r2 = await x.core.receive(commit, mode: .nse)
        XCTAssertEqual(r2.banner?.body, S.pairAgain("Ndev"))
        XCTAssertEqual(r2.banner?.category, .notice)
        // Cancel pairing: entry, pin, pairing id, counter and window gone, then a fresh pairing
        await x.core.cancelPairing(n.id)
        let p = try x.core.store.peer(n.id)!
        XCTAssertFalse(p.pinned)
        XCTAssertEqual(p.lastN, 0)
        XCTAssertNil(try x.core.store.replay(n.id))
        XCTAssertFalse(try x.core.store.allowSet().contains(n.id.text))   // withdrawn by the reconcile
        XCTAssertNil(w.rows[x.id.text]!.allow[n.id.text])
        let r3 = await x.core.receive(commit, mode: .nse)
        XCTAssertEqual(r3.banner?.body, S.pairCommit)
        XCTAssertEqual(try x.core.store.pairing(n.id)?.role, .x)
    }

    func testPairAgainNoticeText() {
        XCTAssertEqual(S.pairAgain("Ndev"), "Ndev wants to pair again. Tap Pair again on its row.")
    }

    func testPairAgainOnHalfStateStartsFreshPairing() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        try n.core.store.dropPin(x.id)                                     // N lost its half, pairs again
        _ = try await n.core.startPair(x.id)
        let commit = w.take(x.id)[0]
        w.rows[n.id.text]!.allow = [:]
        clock.now += 10
        await x.core.fetchPeers(force: true)
        let r = await x.core.receive(commit, mode: .nse)
        XCTAssertEqual(r.banner?.body, S.pairAgain("Ndev"))
        let before = try x.core.store.peer(n.id)!
        XCTAssertTrue(x.core.offersPairAgain(before))                     // the row shows Pair again
        let oldPid = before.pairingId
        // one tap: Cancel pairing (awaited, allow withdrawn), then Pair
        let v = try await x.core.pairAgain(n.id)
        XCTAssertEqual(v, .sent)
        let p = try x.core.store.peer(n.id)!
        XCTAssertFalse(p.pinned)
        XCTAssertNil(p.pairingId)
        XCTAssertEqual(p.lastN, 0)
        XCTAssertNil(p.note)
        XCTAssertNil(try x.core.store.replay(n.id))
        XCTAssertNil(w.rows[x.id.text]!.allow[n.id.text])
        XCTAssertFalse(x.core.offersPairAgain(p))
        XCTAssertEqual(try x.core.store.pairing(n.id)?.role, .n)          // new pairing started
        XCTAssertEqual(try x.core.store.pairing(n.id)?.state, .committed)
        // both sides hold a committed entry: the existing crossing rule settles it
        await n.drainInbox(w)
        if n.id < x.id {
            clock.now += 61                                                // lower id waits; N taps Send again
            _ = await n.core.sendAgain(x.id)
            await x.drainInbox(w)                                          // X wipes its entry, replies
            await n.drainInbox(w)
            await x.drainInbox(w)
        } else {
            await x.drainInbox(w)                                          // N replied: X sends the open
            await n.drainInbox(w)
        }
        XCTAssertEqual(try x.core.store.pairing(n.id)?.state, .shown)
        XCTAssertEqual(try n.core.store.pairing(x.id)?.state, .shown)
        let fp = try x.core.store.peer(n.id)!.fingerprint
        XCTAssertNotNil(fp)
        XCTAssertEqual(fp, try n.core.store.peer(x.id)!.fingerprint)
        XCTAssertNotEqual(try x.core.store.peer(n.id)!.pairingId, oldPid)
    }

    /// X on a half-state row: N re-paired and X got the commit with Pair again offered.
    private func halfStateRow() async throws -> (n: Device, x: Device) {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        try n.core.store.dropPin(x.id)
        _ = try await n.core.startPair(x.id)
        let commit = w.take(x.id)[0]
        w.rows[n.id.text]!.allow = [:]
        clock.now += 10
        await x.core.fetchPeers(force: true)
        _ = await x.core.receive(commit, mode: .nse)
        XCTAssertTrue(x.core.offersPairAgain(try x.core.store.peer(n.id)!))
        return (n, x)
    }

    func testPairAgainSecondTapChangesNothing() async throws {
        let (n, x) = try await halfStateRow()
        let v = try await x.core.pairAgain(n.id)
        XCTAssertEqual(v, .sent)
        let entry = try x.core.store.pairing(n.id)
        XCTAssertNotNil(entry)
        XCTAssertFalse(w.take(n.id).isEmpty)                             // the commit went out
        do {
            _ = try await x.core.pairAgain(n.id)
            XCTFail("second Pair again must not run")
        } catch let e as Core.PairStartError {
            XCTAssertEqual(e, .notOffered)
        }
        XCTAssertEqual(try x.core.store.pairing(n.id), entry)             // the sent commit is kept
        XCTAssertTrue(w.take(n.id).isEmpty)
        XCTAssertNil(Core.pairAgainToast(.failure(Core.PairStartError.notOffered), name: "Laptop"))
    }

    func testPairAgainRefusedKeepsRow() async throws {
        let (n, x) = try await halfStateRow()
        try x.core.store.db.exec("UPDATE peers SET list_enc_pub = NULL WHERE id = ?", [.text(n.id.text)])
        let before = try x.core.store.peer(n.id)!
        do {
            _ = try await x.core.pairAgain(n.id)
            XCTFail("Pair again must refuse an unlisted peer")
        } catch let e as Core.PairStartError {
            XCTAssertEqual(e, .notListed)
            XCTAssertEqual(Core.pairAgainToast(.failure(e), name: "Laptop"), S.cannotPairYet("Laptop"))
        }
        let after = try x.core.store.peer(n.id)!
        XCTAssertEqual(after.pinned, before.pinned)                       // nothing dropped
        XCTAssertTrue(x.core.offersPairAgain(after))
    }

    func testPairAgainToastText() {
        func t(_ r: Result<PairSendResult, Error>) -> String? { Core.pairAgainToast(r, name: "Laptop") }
        XCTAssertNil(t(.success(.sent)))
        XCTAssertNil(t(.success(.rateLimited(5))))
        XCTAssertEqual(t(.success(.network)), S.pairNotSent)
        XCTAssertEqual(t(.success(.error(500))), S.pairNotSent)
        XCTAssertEqual(t(.success(.result("gone"))), S.cannotPairNow)
        // each refusal says why and what to do (I604)
        XCTAssertNil(t(.failure(Core.PairStartError.notOffered)))
        XCTAssertEqual(t(.failure(Core.PairStartError.pinned)), "Already paired with \"Laptop\".")
        XCTAssertEqual(t(.failure(Core.PairStartError.openEntry)), "Pairing with \"Laptop\" is already in progress.")
        XCTAssertEqual(t(.failure(Core.PairStartError.notListed)),
                       "\"Laptop\" can't pair right now. Open PushArmor on that device, then try again.")
        XCTAssertEqual(t(.failure(Core.PairStartError.tooManyOpen)),
                       "Too many pairings are in progress. Finish or cancel one, then try again.")
    }

    func testFailedCallShowsAToast() {
        func reply(_ status: Int, _ body: String) -> APIOutcome { .reply(APIReply(status: status, body: Data(body.utf8))) }
        XCTAssertNil(Core.failText(reply(200, "{}")))
        XCTAssertEqual(Core.failText(APIOutcome.network), S.noConnection)
        XCTAssertEqual(Core.failText(reply(500, "{\"error\":\"x\"}")), S.notDone)
        XCTAssertEqual(Core.failText(reply(401, "{\"error\":\"clock skew\"}")), S.clockOff)
        XCTAssertEqual(Core.failText(nil as APIOutcome?), S.notDone)              // threw before any reply
        XCTAssertNil(Core.failText(ApproveOutcome.denied))
        XCTAssertNil(Core.failText(ApproveOutcome.result("gone")))
        XCTAssertEqual(Core.failText(ApproveOutcome.network), S.noConnection)
        XCTAssertEqual(Core.failText(ApproveOutcome.error(500)), S.notDone)
    }

    func testWaitingRowGets3dNoticeOnCommitFromX() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairToShown(n, x)
        let ap = await n.core.approve(x.id)                             // N waits for X
        XCTAssertEqual(ap, .stored)
        // X lost its state and pairs again from scratch as N
        try x.core.store.dropPin(n.id)
        _ = try await x.core.startPair(n.id)
        let r = await n.drainInbox(w)
        XCTAssertEqual(r.first?.banner?.body, S.pairAgain(PeerLabel.label(try n.core.store.peer(x.id))))   // no name yet
    }

    func testTimeoutWhileLoggedOutKeepsWaitingThenCompletesAfterLogin() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairToShown(n, x)
        let v12 = await n.core.approve(x.id)
        XCTAssertEqual(v12, .stored)
        let v13 = await x.core.approve(n.id)
        XCTAssertEqual(v13, .completed)
        _ = w.take(n.id)                                                // lost approve push
        _ = try await n.core.logout()
        clock.now += 14 * 86400 + 1
        await n.core.checkTimeouts()
        XCTAssertNotNil(try n.core.store.pairing(x.id))                 // stays Waiting
        XCTAssertTrue(try n.core.store.peer(x.id)!.pinned)
        _ = try await n.core.login(ticket: "t", push: nil)
        XCTAssertTrue(try n.core.store.peer(x.id)!.approveVerified)
        XCTAssertNil(try n.core.store.pairing(x.id))
        await n.core.checkTimeouts()
        XCTAssertTrue(try n.core.store.peer(x.id)!.pinned)
    }

    func testTimeoutFoundWhileLoggedOutDropsLocallyAndWithdraws() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        await x.core.fetchPeers(force: true)
        _ = try await n.core.startPair(x.id)
        await x.drainInbox(w)
        await n.drainInbox(w)
        await x.drainInbox(w)                                           // both shown, X approves nothing
        // N's allow set holds X (an approve was being prepared), then N logs out
        try n.core.store.allowAdd([x.id.text])
        w.rows[n.id.text]!.allow[x.id.text] = true
        w.rows[n.id.text]!.loggedOut = true
        try n.core.store.setMe("logged_out", .int(1))
        clock.now += 14 * 86400 + 1
        let callsBefore = w.calls.count
        await n.core.checkTimeouts()
        XCTAssertFalse(try n.core.store.peer(x.id)!.pinned)
        XCTAssertEqual(try n.core.store.peer(x.id)!.note, PairNote.timedOut.rawValue)
        // nothing sent except through the reconcile: one withdraw, accepted while logged out
        XCTAssertEqual(w.calls.count - callsBefore, 1)
        XCTAssertNil(w.rows[n.id.text]!.allow[x.id.text])
        let out = try await n.core.login(ticket: "t", push: nil)
        XCTAssertEqual(out.reply?.status, 200)
    }

    func testPeerWithdrawsAfterPairingShowsNotPairedJustCompletedStaysPaired() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        // an older GET (fetched before the verify) showing approves_me false never counts
        var p = try n.core.store.peer(x.id)!
        p.getApprovesMe = false
        p.getAt = p.approveVerifiedAt! - 1
        try n.core.store.savePeer(p)
        XCTAssertFalse(try n.core.store.peer(x.id)!.notPairedOnPeer)
        XCTAssertTrue(try n.core.store.peer(x.id)!.inAll)
        // X withdraws: a later GET shows approves_me false
        w.rows[x.id.text]!.allow = [:]
        clock.now += 5
        await n.core.fetchPeers(force: true)
        XCTAssertTrue(try n.core.store.peer(x.id)!.notPairedOnPeer)
        XCTAssertFalse(try n.core.store.peer(x.id)!.inAll)
        XCTAssertTrue(n.core.offersCancel(try n.core.store.peer(x.id)!))
    }

    func testDifferentCNAbortsVisiblyAndWrongPairingIdCouldNotRead() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        await n.core.fetchPeers(force: true)
        await x.core.fetchPeers(force: true)
        _ = try await n.core.startPair(x.id)
        await x.drainInbox(w)
        _ = w.take(n.id)
        // N restarts the pairing (new r_N): a different c_N aborts X's entry
        try n.core.store.deletePairing(x.id)
        _ = try await n.core.startPair(x.id)
        let r = await x.drainInbox(w)
        XCTAssertEqual(r.first?.banner, .dropped)
        XCTAssertNil(try x.core.store.pairing(n.id))
        XCTAssertEqual(try x.core.store.peer(n.id)!.note, PairNote.failed.rawValue)
    }

    func testWrongPairingIdIsCouldNotRead() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        try x.core.store.db.exec("UPDATE peers SET pairing_id = ? WHERE id = ?", [.blob(Data(count: 8)), .text(n.id.text)])
        try x.core.store.db.exec("UPDATE replay SET pairing_id = ? WHERE peer_id = ?", [.blob(Data(count: 8)), .text(n.id.text)])
        _ = try await n.core.send("x", as: .text, to: [x.id], allCount: 1)
        let r = await x.drainInbox(w)
        XCTAssertEqual(r.first?.banner, .dropped)
        XCTAssertEqual(try x.core.store.history().first?.event, .couldNotRead)
    }

    func testSelfRemovalWipeLeavesNoRows() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev"), o = try dev("Odev")
        try await pairFully(n, x)
        await o.core.fetchPeers(force: true)
        _ = try await o.core.startPair(x.id)
        await x.drainInbox(w)                                             // x holds an open entry and a cap stamp
        _ = try await n.core.send("keep me", as: .text, to: [x.id], allCount: 1)
        await x.drainInbox(w)
        _ = try await n.core.removePeer(x.id)
        let r = await x.drainInbox(w)
        XCTAssertEqual(r.last?.banner?.body, S.thisDeviceRemoved)
        let s = x.core.store
        XCTAssertTrue(try s.me().removed)
        XCTAssertEqual(try s.pairings().count, 0)
        XCTAssertEqual(try s.capTimestamps().count, 0)
        XCTAssertEqual(try s.db.query("SELECT * FROM replay").count, 0)
        XCTAssertEqual(try s.peers().filter { $0.lastN != 0 || $0.pinned }.count, 0)
        XCTAssertTrue(try s.history().contains { $0.content == "keep me" })   // history kept
        // n dropped x's pin, keeps the row as removed
        XCTAssertEqual(try n.core.store.peer(x.id)?.state, .removed)
    }

    func testLogoutNoticeEventsAndOrdering() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        _ = try await n.core.logout()
        let r = await x.drainInbox(w)
        XCTAssertEqual(r.first?.banner?.body, S.loggedOutNotice("Ndev"))
        XCTAssertEqual(r.first?.banner?.category, .notice)
        XCTAssertTrue(try x.core.store.peer(n.id)!.loggedOut)
        XCTAssertEqual(try x.core.store.history().first?.event, .loggedOut)
        XCTAssertFalse(try x.core.store.peer(n.id)!.inAll)
    }

    func testUnknownSenderSetsFetchDueAndEventsMerge() async throws {
        let x = try dev("Xdev"), o = try dev("Odev")
        await o.core.fetchPeers(force: true)
        // forge: o pins x locally only, so x does not know o
        try o.core.store.pin(x.id, signPub: x.keys.signer.publicKey, encPub: x.keys.decryptor.publicKey,
                             pairingId: Data(count: 8), fingerprint: "AAAA")
        let m = try o.core.buildMessage(to: x.id) { _ in .text("hi") }
        let m2 = try o.core.buildMessage(to: x.id) { _ in .text("hi") }
        clock.now += 100
        let r = await x.core.receive(m, mode: .nse)
        XCTAssertEqual(r.banner, .dropped)
        _ = await x.core.receive(m2, mode: .nse)
        let h = try x.core.store.history()
        XCTAssertEqual(h.count, 1)
        XCTAssertEqual(h[0].count, 2)
        XCTAssertNil(h[0].peerId)                                         // "Unknown sender"
        XCTAssertFalse(h[0].read == false)                               // events never unread
        // the NSE ran one fetch inside the coalescing window rules
        XCTAssertTrue(try x.core.store.me().fetchDue || w.count("GET", "/v1/peers") >= 1)
    }

    func testRenameRefusesDoubleQuote() async throws {
        let n = try dev("Ndev")
        do {
            _ = try await n.core.rename("Bad \"name\"")
            XCTFail("a name with a double quote was accepted")
        } catch Core.CoreError.refused(let what) {
            XCTAssertEqual(what, "name")
        }
        XCTAssertEqual(try n.core.store.me().name, "Ndev")
    }

    func testDBMigrationIdempotent() throws {
        let path = NSTemporaryDirectory() + "pa-mig-\(UUID().uuidString).sqlite"
        _ = try Store(path: path)
        let s = try Store(path: path)
        XCTAssertEqual(try s.db.one("PRAGMA user_version")?.int("user_version"), 4)
        XCTAssertEqual(try s.db.one("PRAGMA journal_mode")?.text("journal_mode"), "wal")
        XCTAssertNil(try s.me().id)
    }

    func testDBMigrationRenamesPauseColumns() throws {
        let path = NSTemporaryDirectory() + "pa-mig2-\(UUID().uuidString).sqlite"
        // Rebuild a version 1 file: the old column names, old event words, no listening column
        // (migration 3) and user_version 1.
        do {
            let s = try Store(path: path)
            try s.db.exec("ALTER TABLE peers DROP COLUMN listening")
            try s.db.exec("ALTER TABLE me RENAME COLUMN logged_out TO paused")
            try s.db.exec("ALTER TABLE peers RENAME COLUMN logged_out TO paused")
            try s.db.exec("ALTER TABLE peers RENAME COLUMN logout_n TO pause_n")
            try s.db.exec("UPDATE me SET paused = 1")
            try s.db.exec("INSERT INTO peers (id, paused, pause_n) VALUES ('p1', 1, 7)")
            try s.db.exec("""
                INSERT INTO history (dir, type, content, event, created_local)
                VALUES ('in', 'event', 'a', 'paused', 1), ('in', 'event', 'b', 'resumed', 2)
                """)
            try s.db.exec("PRAGMA user_version = 1")
        }
        let s = try Store(path: path)
        XCTAssertEqual(try s.db.one("PRAGMA user_version")?.int("user_version"), 4)
        XCTAssertTrue(try s.me().loggedOut)
        let p = try s.db.one("SELECT logged_out, logout_n FROM peers WHERE id = 'p1'")
        XCTAssertEqual(p?.int("logged_out"), 1)
        XCTAssertEqual(p?.int("logout_n"), 7)
        let ev = try s.db.query("SELECT event FROM history ORDER BY created_local").map { $0.text("event") }
        XCTAssertEqual(ev, ["logged_out", "logged_in"])
    }

    func testDBMigrationAddsListeningDefaultTrue() throws {
        let path = NSTemporaryDirectory() + "pa-mig3-\(UUID().uuidString).sqlite"
        // Rebuild a version 2 file: no listening column, user_version 2.
        do {
            let s = try Store(path: path)
            try s.db.exec("ALTER TABLE peers DROP COLUMN listening")
            try s.db.exec("INSERT INTO peers (id, platform) VALUES ('p1', 'android')")
            try s.db.exec("PRAGMA user_version = 2")
        }
        let s = try Store(path: path)
        XCTAssertEqual(try s.db.one("PRAGMA user_version")?.int("user_version"), 4)
        XCTAssertEqual(try s.db.one("SELECT listening FROM peers WHERE id = 'p1'")?.int("listening"), 1)
        let a = TestPeer()
        var p = Peer(id: a.id); p.listening = false; try s.savePeer(p)
        XCTAssertEqual(try s.peer(a.id)?.listening, false)
    }

    func testDBMigrationClockOffsetToSeconds() throws {
        let path = NSTemporaryDirectory() + "pa-mig4-\(UUID().uuidString).sqlite"
        // Rebuild a version 3 file holding a ms offset (Q331).
        do {
            let s = try Store(path: path)
            try s.db.exec("UPDATE me SET clock_offset = -7500")
            try s.db.exec("PRAGMA user_version = 3")
        }
        let s = try Store(path: path)
        XCTAssertEqual(try s.db.one("PRAGMA user_version")?.int("user_version"), 4)
        XCTAssertEqual(try s.me().clockOffset, -7)
    }

    /// Q332: a corrupt pa.sqlite runs onCorrupt and is recreated empty; a healthy one is kept.
    func testCorruptStoreRepaired() async throws {
        let path = NSTemporaryDirectory() + "pa-bad-\(UUID().uuidString).sqlite"
        try Data(repeating: 0x5a, count: 4096).write(to: URL(fileURLWithPath: path))
        var called = 0
        let r = try await StoreRepair.open(path: path) { called += 1 }
        XCTAssertTrue(r.repaired)
        XCTAssertEqual(called, 1)
        XCTAssertNil(try r.store.me().id)
        XCTAssertEqual(try r.store.db.one("PRAGMA user_version")?.int("user_version"), 4)
        try r.store.setMe("name", .text("kept"))
        let r2 = try await StoreRepair.open(path: path) { called += 1 }
        XCTAssertFalse(r2.repaired)
        XCTAssertEqual(called, 1)
        XCTAssertEqual(try r2.store.me().name, "kept")
    }

    /// Q332: the best-effort DELETE of this device is signed with the surviving keys and
    /// retried once on clock skew.
    func testDeleteSelfAfterCorruption() async {
        let w = FakeWorker(), p = TestPeer()
        w.add(p.id, signPub: p.signPub, encPub: p.encPub)
        let api = APIClient(base: URL(string: "https://api.test")!, transport: w, clockMs: { 1761300000000 }, sleep: { _ in })
        w.script("DELETE", "/v1/peers/", 401, "{\"error\":\"clock skew\"}")
        let ok = await StoreRepair.deleteSelf(api: api, signer: p.signer, id: p.id)
        XCTAssertTrue(ok)
        XCTAssertEqual(w.count("DELETE", "/v1/peers/" + p.id.text), 2)
        XCTAssertNil(w.rows[p.id.text])
        w.offline = true
        let ok2 = await StoreRepair.deleteSelf(api: api, signer: p.signer, id: p.id)
        XCTAssertFalse(ok2)
    }

    func testCliPeerListeningParsedAndSendOnlyExcluded() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        w.rows[x.id.text]!.platform = "cli"
        w.rows[x.id.text]!.listening = true
        await n.core.fetchPeers(force: true)
        var p = try n.core.store.peer(x.id)!
        XCTAssertEqual(p.platform, "cli")
        XCTAssertTrue(p.listening)
        XCTAssertTrue(p.inAll)
        XCTAssertTrue(p.canReceive)
        // a cli device that stopped listening: send only, out of All and not a send target
        w.rows[x.id.text]!.listening = false
        await n.core.fetchPeers(force: true)
        p = try n.core.store.peer(x.id)!
        XCTAssertFalse(p.listening)
        XCTAssertFalse(p.inAll)
        XCTAssertFalse(p.canReceive)
        XCTAssertEqual(try n.core.allSet().count, 0)
        // the key absent (another platform) reads as listening
        w.rows[x.id.text]!.listening = nil
        await n.core.fetchPeers(force: true)
        XCTAssertTrue(try n.core.store.peer(x.id)!.listening)
    }

    func testSendFailureResultsEachShowALine() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        await n.core.fetchPeers(force: true)
        let label = PeerLabel.label(try n.core.store.peer(x.id))
        w.rows[x.id.text]!.allow[n.id.text] = nil
        var rep = try await n.core.send("hi", as: .text, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.lines, [label + ": Not paired. Pair with it to send messages."])
        w.rows[x.id.text]!.allow[n.id.text] = true
        w.rows[x.id.text]!.deny[n.id.text] = true
        rep = try await n.core.send("hi", as: .text, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.lines, [label + ": It declined this device."])
        w.rows[x.id.text] = nil
        rep = try await n.core.send("hi", as: .text, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.lines, [label + ": It is no longer on this account."])
        XCTAssertEqual(S.signedOutPeer("A"), "A: Logged out. Log in on it to receive messages.")
        XCTAssertEqual(S.notDelivered("A"), "Not delivered to A: open PushArmor on it.")
        XCTAssertEqual(S.notDeliveredRetry("A"), "A: Not delivered. Try again.")
    }

    func testSendNotListeningShowsSendOnly() async throws {
        let n = try dev("Ndev"), x = try dev("Xdev")
        try await pairFully(n, x)
        await n.core.fetchPeers(force: true)
        w.rows[x.id.text]!.platform = "cli"
        w.rows[x.id.text]!.listening = false
        let rep = try await n.core.send("hi", as: .text, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.results[x.id.text], "not listening")
        let label = PeerLabel.label(try n.core.store.peer(x.id))
        XCTAssertEqual(rep.toast, "Sent to 0 of 1 device\n" + S.sendOnlyPeer(label))
        XCTAssertTrue(S.sendOnlyPeer("Xdev").hasSuffix("Send only. It does not receive messages."))
        XCTAssertFalse(try n.core.store.peer(x.id)!.listening)
        XCTAssertTrue(try n.core.store.me().fetchDue)
        XCTAssertTrue(w.take(x.id).isEmpty)
    }

    func testLockScreenBody() {
        func b(_ ms: Bool, _ ps: Bool, _ ma: Bool, _ pa: Bool, _ locked: Bool) -> String {
            LockScreen.body(mainShow: ms, peerShow: ps, mainAlwaysHide: ma, peerAlwaysHide: pa, locked: locked, peerName: "P", content: "C")
        }
        XCTAssertEqual(b(true, true, false, false, true), "C")
        XCTAssertEqual(b(false, true, false, false, true), "New message from P")
        XCTAssertEqual(b(true, false, false, false, true), "New message from P")
        XCTAssertEqual(b(false, false, false, false, false), "C")          // unlocked: full content
        XCTAssertEqual(b(true, true, true, false, false), "New message from P")
        XCTAssertEqual(b(true, true, false, true, false), "New message from P")
    }

    func testHistoryFilter() throws {
        let path = NSTemporaryDirectory() + "pa-hf-\(UUID().uuidString).sqlite"
        let s = try Store(path: path)
        let a = TestPeer(), b = TestPeer()
        var pa = Peer(id: a.id); pa.name = "A"; try s.savePeer(pa)
        var pb = Peer(id: b.id); pb.name = "B"; try s.savePeer(pb)
        try s.addMessage(dir: .incoming, peer: a.id, type: "text", content: "1", n: 1, pairingId: nil, read: false, results: nil, now: 1)
        var f = HistoryFilter.options(rows: try s.history(), peers: try s.peers())
        XCTAssertEqual(f, [.all])                                          // only one peer: per-peer entries hidden
        try s.addMessage(dir: .incoming, peer: b.id, type: "text", content: "2", n: 1, pairingId: nil, read: false, results: nil, now: 2)
        try s.addMessage(dir: .outgoing, peer: a.id, type: "text", content: "3", n: nil, pairingId: nil, read: true, results: "{}", now: 3)
        try s.addEvent(.couldNotRead, peer: nil, content: S.dropped, now: 4)
        f = HistoryFilter.options(rows: try s.history(), peers: try s.peers())
        XCTAssertEqual(f, [.all, .peer(a.id.text, "A"), .peer(b.id.text, "B"), .unknown])
        XCTAssertEqual(HistoryFilter.apply(.peer(a.id.text, "A"), try s.history()).map { $0.content }, ["1"])  // received only
        XCTAssertEqual(HistoryFilter.apply(.unknown, try s.history()).count, 1)
        XCTAssertEqual(HistoryFilter.apply(.all, try s.history()).count, 4)
    }
}
