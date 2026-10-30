package com.pusharmor.protocol.engine

import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Countdown
import com.pusharmor.protocol.PairDecide
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

/** Client state-machine tests (CI design section 3: per-platform tests). */
class EngineTest {
    private val t0 = 1_761_300_000_000L
    private val w = FakeWorker()
    private val n = w.add("N")
    private val x = w.add("X")

    init { n.fetch(); x.fetch() }

    /** Pair N -> X up to "shown" on both sides. */
    private fun pairShown(now: Long = t0) {
        assertTrue(n.pairing.tapPair(x.id, now))
        n.runPairSends(now)
        x.deliver(now)
        x.runPairSends(now)
        n.deliver(now)
        n.runPairSends(now)
        x.deliver(now)
        assertEquals(PairState.SHOWN, n.store.pairing(x.id)!!.state)
        assertEquals(PairState.SHOWN, x.store.pairing(n.id)!!.state)
    }

    private fun approveBoth(now: Long = t0) {
        assertEquals("stored", (n.approve.approve(x.id) as ApiResult.Ok).value.result)
        assertTrue(n.store.peer(x.id)!!.waiting)
        val r = x.approve.approve(n.id) as ApiResult.Ok
        assertEquals("sent", r.value.result)
        assertTrue(x.store.peer(n.id)!!.approveVerified) // the returned c verified
        n.deliver(now)
    }

    @Test fun fullPairingThenSend() {
        pairShown()
        assertEquals(n.store.pairing(x.id)!!.fingerprint, x.store.pairing(n.id)!!.fingerprint)
        assertTrue(n.store.peer(x.id)!!.pairingId!!.contentEquals(x.store.peer(n.id)!!.pairingId!!))
        assertTrue(x.effects.log.any { it.startsWith("pair:COMPARE") })
        // the open replaced the commit notice: same pk id
        val pks = x.effects.log.filter { it.startsWith("pair:") }.map { it.split(":")[2] }.toSet()
        assertEquals(1, pks.size)
        approveBoth()
        assertTrue(n.store.peer(x.id)!!.approveVerified)
        assertNull(n.store.pairing(x.id)) // entry ended, r wiped
        assertNull(x.store.pairing(n.id))
        // a returned c raises no notice and no event on X
        assertFalse(x.effects.log.any { it.startsWith("approved") })
        n.fetch(); x.fetch()
        val out = n.send.send(listOf(x.id), ContentType.TEXT, "hello", t0)
        assertEquals(mapOf(x.id to "sent"), out.results)
        x.deliver(t0)
        assertTrue(x.effects.log.contains("show:hello"))
    }

    @Test fun lostApprovePushRecoveredByRefetchSameBytes() {
        pairShown()
        n.approve.approve(x.id)
        val stored = n.store.peer(x.id)!!.storedApprove
        val nAfterApprove = n.store.peer(x.id)!!.lastN
        x.approve.approve(n.id)
        n.deliver(t0, drop = true) // X's approve push lost
        assertTrue(n.store.peer(x.id)!!.waiting)
        assertEquals(PairDecide.Resend.OK_C_VERIFIED, n.approve.refetch(x.id))
        assertEquals(stored, n.store.peer(x.id)!!.storedApprove) // same bytes
        assertEquals(nAfterApprove, n.store.peer(x.id)!!.lastN) // same n
        assertTrue(n.store.peer(x.id)!!.approveVerified)
        // X gets N's relayed approve again: a seen-n duplicate, no state change
        x.deliver(t0)
        assertFalse(x.effects.log.contains("invalid"))
    }

    @Test fun refetchSilentOn429AndFreshAfterRename() {
        pairShown()
        n.approve.approve(x.id)
        n.rateLimitNext = 1
        assertEquals(PairDecide.Resend.RATE_LIMITED, n.approve.refetch(x.id))
        assertTrue(n.store.peer(x.id)!!.waiting)
        val before = n.store.peer(x.id)!!.storedApprove
        n.store.name = "Renamed"
        n.approve.refetch(x.id)
        assertNotEquals(before, n.store.peer(x.id)!!.storedApprove)
        assertEquals("Renamed", n.store.peer(x.id)!!.storedApproveName)
    }

    @Test fun clockSkewRebuildsWithNewCounterAndSecondStops() {
        pairShown(); approveBoth(); n.fetch()
        val last = n.store.peer(x.id)!!.lastN
        n.skewNext = 1
        val ok = n.send.send(listOf(x.id), ContentType.TEXT, "a", t0)
        assertEquals(1, ok.sent)
        assertEquals(last + 2, n.store.peer(x.id)!!.lastN) // discarded build, new n
        n.skewNext = 2
        val bad = n.send.send(listOf(x.id), ContentType.TEXT, "b", t0)
        assertTrue(bad.error!!.isClockSkew)
        x.deliver(t0)
        assertEquals(1, x.effects.log.count { it == "show:a" })
    }

    @Test fun counterReservedConcurrentlyIsDistinct() {
        pairShown()
        val pool = Executors.newFixedThreadPool(8)
        val got = java.util.Collections.synchronizedList(ArrayList<Long>())
        val latch = CountDownLatch(200)
        repeat(200) { pool.execute { got.add(n.store.reserveCounter(x.id)); latch.countDown() } }
        latch.await()
        pool.shutdown()
        assertEquals(200, got.toSet().size)
    }

    @Test fun putPeerWithStaleCopyDoesNotRollBackCounter() {
        pairShown()
        val stale = n.store.peer(x.id)!!
        val reserved = n.store.reserveCounter(x.id)
        n.store.putPeer(stale.copy(hidden = !stale.hidden))
        assertEquals(reserved, n.store.peer(x.id)!!.lastN)
        n.store.resetCounter(x.id)
        assertEquals(0L, n.store.peer(x.id)!!.lastN)
    }

    @Test fun pairSendClockSkewIsRetriedNotPermanent() {
        assertTrue(n.pairing.tapPair(x.id, t0))
        n.skewNext = 1
        assertEquals(PairingEngine.SendStep.RETRY, n.pairing.sendPending(x.id, t0))
        assertEquals(PairingEngine.SendStep.DONE, n.pairing.sendPending(x.id, t0))
        assertEquals("sent", n.store.pairing(x.id)!!.lastResult)
    }

    @Test fun allowReconcile() {
        pairShown()
        n.approve.approve(x.id) // allow has X (pinned)
        n.store.addAllow("orphan-not-pinned")
        n.reconcile.run()
        assertEquals(listOf("withdraw:orphan-not-pinned"), n.calls.filter { it.startsWith("withdraw") })
        assertTrue(x.id in n.store.allowSet()) // pinned never withdrawn
        // Cancel pairing: local only, then the reconcile withdraws X
        n.calls.clear()
        n.pairing.cancelPairing(x.id)
        assertTrue(n.calls.isEmpty())
        assertTrue(n.effects.log.contains("reconcile"))
        n.reconcile.run()
        assertEquals(listOf("withdraw:${x.id}"), n.calls)
        assertFalse(x.id in n.allow)
    }

    @Test fun messagesMissingWithdrawsThenRetriesAndLogoutWorksWhileLoggedOutWithdraw() {
        pairShown()
        n.approve.approve(x.id)
        n.pairing.cancelPairing(x.id) // approve lost reply case: allow holds X, no pin
        n.store.replaceAllowSet(emptyList()) // stale local set: the Worker still has X
        val logout = LogoutFlow(n.store, n.me, n.api, n.reconcile)
        val r = logout.logout()
        assertTrue(r is ApiResult.Ok)
        assertEquals(listOf("logout", "withdraw:${x.id}", "logout"), n.calls.filter { it == "logout" || it.startsWith("withdraw") })
        assertTrue(n.loggedOut)
        // a withdraw passes the logout gate
        n.allow.add("y"); n.store.addAllow("y")
        n.reconcile.run()
        assertFalse("y" in n.allow)
    }

    @Test fun capElevenThPromptedAndSurvivesRestart() {
        val senders = (1..11).map { w.add("S$it") }
        x.fetch()
        for (s in senders) { s.fetch(); s.pairing.tapPair(x.id, t0); s.runPairSends(t0) }
        x.deliver(t0)
        val rows = x.store.pairings()
        assertEquals(9, rows.size) // at most 9 open entries
        assertEquals(9, x.store.capTimestamps().size)
        // close entries, then more commits: the cap counts across ids and survives a new engine
        for (r in rows) x.pairing.cancelPairing(r.peerId)
        val x2 = PairingEngine(x.store, x.me, x.api, x.effects) { ByteArray(it) { 7 } }
        val more = (1..2).map { w.add("T$it") }
        x.fetch()
        for (s in more) { s.fetch(); s.pairing.tapPair(x.id, t0 + 1000); s.runPairSends(t0 + 1000) }
        for (m in x.inbox.toList()) x2.onPush(m, t0 + 1000) { true }
        x.inbox.clear()
        val states = more.map { x.store.pairing(it.id)!! }
        assertEquals(PairState.REPLIED, states[0].state) // 10th automatic reply
        assertEquals(PairState.PROMPTED, states[1].state) // 11th: prompted, needs [Reply]
        assertFalse(states[1].authorized)
        assertTrue(x2.tapReply(more[1].id))
        assertTrue(x.store.pairing(more[1].id)!!.authorized)
        assertEquals(10, x.store.capTimestamps().size) // tapped reply not counted
    }

    @Test fun twoConcurrentCommitsAtCapMinusOneGiveOneAutomaticReply() {
        repeat(9) { x.store.addCapTimestamp(t0 / 1000 - 10) }
        val a = w.add("A"); val b = w.add("B")
        x.fetch(); a.fetch(); b.fetch()
        a.pairing.tapPair(x.id, t0); a.runPairSends(t0)
        b.pairing.tapPair(x.id, t0); b.runPairSends(t0)
        val msgs = x.inbox.toList(); x.inbox.clear()
        val pool = Executors.newFixedThreadPool(2)
        val latch = CountDownLatch(2)
        for (m in msgs) pool.execute { x.pairing.onPush(m, t0) { true }; latch.countDown() }
        latch.await(); pool.shutdown()
        val states = listOf(a, b).map { x.store.pairing(it.id)!!.state }.sorted()
        assertEquals(listOf(PairState.PROMPTED, PairState.REPLIED), states)
        assertEquals(10, x.store.capTimestamps().size)
    }

    @Test fun duplicateCommitResendsSameReplyOnlyWhenAuthorized() {
        n.pairing.tapPair(x.id, t0); n.runPairSends(t0)
        val commit = x.inbox.first()
        x.deliver(t0)
        val rX = x.store.pairing(n.id)!!.r.copyOf()
        x.runPairSends(t0)
        x.inbox.add(commit); x.deliver(t0)
        assertTrue(x.store.pairing(n.id)!!.r.contentEquals(rX))
        assertNotNull(x.store.pairing(n.id)!!.pendingMessage) // re-send queued
        assertEquals(1, x.store.capTimestamps().size) // not counted again
    }

    @Test fun differentCommitAbortsVisibly() {
        n.pairing.tapPair(x.id, t0); n.runPairSends(t0); x.deliver(t0)
        n.pairing.cancelPairing(x.id)
        n.pairing.tapPair(x.id, t0 + 1); n.runPairSends(t0 + 1)
        x.deliver(t0 + 1)
        assertNull(x.store.pairing(n.id))
        assertEquals(PairingEngine.PAIRING_FAILED, x.store.peer(n.id)!!.note)
        assertTrue(x.effects.log.contains("couldNotRead"))
    }

    @Test fun crossingLowerIdStaysN() {
        n.pairing.tapPair(x.id, t0); x.pairing.tapPair(n.id, t0)
        n.runPairSends(t0); x.runPairSends(t0)
        n.deliver(t0); x.deliver(t0)
        val lowerIsN = com.pusharmor.crypto.Ids.compareUnsigned(n.me.idRaw, x.me.idRaw) < 0
        val (low, high) = if (lowerIsN) n to x else x to n
        assertEquals(PairRole.N, low.store.pairing(high.id)!!.role)
        assertEquals(PairRole.X, high.store.pairing(low.id)!!.role)
        assertTrue(low.effects.log.any { it.startsWith("pair:IN_PROGRESS") })
        // finish: both shown, one pairing
        high.runPairSends(t0); low.deliver(t0); low.runPairSends(t0); high.deliver(t0)
        assertEquals(PairState.SHOWN, low.store.pairing(high.id)!!.state)
        assertEquals(PairState.SHOWN, high.store.pairing(low.id)!!.state)
        assertEquals(low.store.pairing(high.id)!!.fingerprint, high.store.pairing(low.id)!!.fingerprint)
    }

    @Test fun persistedStateValidAtDay13AndTimeoutAtDay14() {
        n.pairing.tapPair(x.id, t0); n.runPairSends(t0)
        val day = 24 * 3600_000L
        val restarted = PairingEngine(n.store, n.me, n.api, n.effects) { ByteArray(it) }
        assertNull(restarted.checkTimeout(x.id, t0 + 13 * day) { error("no") })
        assertEquals("1 days", Countdown.format(n.store.pairing(x.id)!!.startedAt, t0 + 13 * day))
        assertEquals(PairDecide.Timeout.DROP_PIN, restarted.checkTimeout(x.id, t0 + 14 * day) { error("no") })
        assertNull(n.store.pairing(x.id))
        assertEquals(PairingEngine.TIMED_OUT, n.store.peer(x.id)!!.note)
        assertTrue(n.effects.log.contains("reconcile"))
    }

    @Test fun timeoutWhileLoggedOutKeepsWaitingThenRefetchCompletes() {
        pairShown()
        n.approve.approve(x.id)
        x.approve.approve(n.id)
        n.deliver(t0, drop = true)
        n.loggedOut = true
        val day = 24 * 3600_000L
        assertEquals(PairDecide.Timeout.KEEP_WAITING, n.pairing.checkTimeout(x.id, t0 + 15 * day, n.approve::refetch))
        assertTrue(n.store.peer(x.id)!!.pinned)
        n.loggedOut = false
        assertEquals(PairDecide.Timeout.COMPLETE, n.pairing.checkTimeout(x.id, t0 + 15 * day, n.approve::refetch))
        assertTrue(n.store.peer(x.id)!!.approveVerified)
        assertNull(n.store.pairing(x.id))
    }

    @Test fun twoPairingsOpenAtOnceHaveOwnFingerprintAndCountdown() {
        val o = w.add("O"); n.fetch(); o.fetch(); x.fetch()
        n.pairing.tapPair(x.id, t0); n.pairing.tapPair(o.id, t0 + 3600_000)
        n.runPairSends(t0 + 3600_000); x.deliver(t0); o.deliver(t0)
        x.runPairSends(t0); o.runPairSends(t0); n.deliver(t0)
        val a = n.store.pairing(x.id)!!; val b = n.store.pairing(o.id)!!
        assertNotEquals(a.fingerprint, b.fingerprint)
        assertNotEquals(Countdown.format(a.startedAt, t0 + 3600_000), Countdown.format(b.startedAt, t0 + 3600_000))
    }

    @Test fun afterCancelNextPairingIsFresh() {
        pairShown(); approveBoth()
        val oldPid = n.store.peer(x.id)!!.pairingId!!
        n.pairing.cancelPairing(x.id)
        x.pairing.cancelPairing(n.id)
        n.fetch(); x.fetch()
        pairShown(t0 + 1000)
        assertFalse(oldPid.contentEquals(n.store.peer(x.id)!!.pairingId!!))
        assertEquals(0L, n.store.peer(x.id)!!.lastN)
        assertEquals(0L, n.store.window(x.id)!!.h)
    }

    @Test fun commitFromPinnedHalfStateGivesPairAgainNotice() {
        pairShown()
        n.approve.approve(x.id) // N waiting; X never approves
        x.pairing.cancelPairing(n.id); x.fetch()
        x.pairing.tapPair(n.id, t0); x.runPairSends(t0)
        n.deliver(t0)
        assertTrue(n.effects.log.any { it.startsWith("pair:PAIR_AGAIN") })
        assertEquals(PairRole.N, n.store.pairing(x.id)!!.role) // unchanged
    }

    @Test fun pairAgainMarkerOnlyFromHalfStateCommitAndClearedByCancelOrPair() {
        pairShown()
        n.approve.approve(x.id)
        assertTrue(n.store.peer(x.id)!!.waiting)
        assertFalse(n.store.peer(x.id)!!.offersPairAgain) // plain waiting row keeps Cancel pairing
        assertFalse(n.pairing.pairAgain(x.id, t0) {})
        x.pairing.cancelPairing(n.id); x.fetch()
        x.pairing.tapPair(n.id, t0); x.runPairSends(t0)
        n.deliver(t0)
        assertTrue(n.store.peer(x.id)!!.offersPairAgain)
        n.pairing.cancelPairing(x.id)
        assertFalse(n.store.peer(x.id)!!.pairAgain) // cleared by Cancel pairing
        n.store.putPeer(n.store.peer(x.id)!!.copy(pairAgain = true))
        assertTrue(n.pairing.tapPair(x.id, t0 + 1))
        assertFalse(n.store.peer(x.id)!!.pairAgain) // cleared by starting a pair
    }

    @Test fun pairAgainOnHalfStateCancelsThenStartsFreshPairing() {
        pairShown()
        n.approve.approve(x.id) // N waiting; X never approves
        x.pairing.cancelPairing(n.id); x.fetch()
        x.pairing.tapPair(n.id, t0); x.runPairSends(t0)
        n.deliver(t0)
        assertTrue(n.store.peer(x.id)!!.waiting) // the half state row
        assertTrue(n.store.peer(x.id)!!.offersPairAgain) // marker set with the notice
        val oldPid = n.store.peer(x.id)!!.pairingId!!
        val oldCommit = n.store.pairing(x.id)!!.cN!!.copyOf()
        var reconciled = false
        assertTrue(n.pairing.pairAgain(x.id, t0 + 1000) { n.reconcile.run(); reconciled = true })
        assertTrue(reconciled) // the cancel's reconcile lands before the new pairing starts
        assertFalse(x.id in n.allow)
        val p = n.store.peer(x.id)!!
        assertFalse(p.pairAgain) // marker cleared
        assertFalse(p.pinned) // old pin and pairing id dropped
        assertNull(p.pairingId)
        val row = n.store.pairing(x.id)!!
        assertEquals(PairRole.N, row.role)
        assertEquals(PairState.COMMITTED, row.state) // new pairing started
        assertFalse(row.cN!!.contentEquals(oldCommit))
        assertFalse(n.pairing.pairAgain(x.id, t0 + 1000) {}) // not a half state now
        // it completes as a fresh pairing. The two commits cross; lower id stays N. When X is the
        // lower id it already sent its commit, so X uses Send again (60 s), as after a two-step cancel.
        var t1 = t0 + 1000
        repeat(3) { n.runPairSends(t1); x.runPairSends(t1); x.deliver(t1); n.deliver(t1) }
        if (x.store.pairing(n.id)!!.let { it.role == PairRole.N && it.state == PairState.COMMITTED }) {
            t1 += PairingEngine.SEND_AGAIN_MS
            assertTrue(x.pairing.sendAgain(n.id, t1))
            repeat(3) { n.runPairSends(t1); x.runPairSends(t1); x.deliver(t1); n.deliver(t1) }
        }
        assertEquals(PairState.SHOWN, n.store.pairing(x.id)!!.state)
        assertEquals(PairState.SHOWN, x.store.pairing(n.id)!!.state)
        assertEquals(n.store.pairing(x.id)!!.fingerprint, x.store.pairing(n.id)!!.fingerprint)
        assertFalse(oldPid.contentEquals(n.store.peer(x.id)!!.pairingId!!))
    }

    @Test fun replayGivesInvalidAndHistoryDuplicateRepresents() {
        pairShown(); approveBoth(); n.fetch()
        n.send.send(listOf(x.id), ContentType.TEXT, "once", t0)
        val m = x.inbox.first()
        x.deliver(t0)
        x.inbox.add(m); x.deliver(t0)
        assertTrue(x.effects.log.any { it.startsWith("represent:") })
        assertFalse(x.effects.log.contains("invalid"))
    }
}
