package com.pusharmor.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiveTest {
    private val a = TestPeer()
    private val b = TestPeer()
    private val pid = ByteArray(8) { 6 }

    private fun ok(n: Long, body: MessageBody) = OpenResult.Ok(a.id, n, body, pid)

    @Test fun replayOutcomes() {
        val peer = a.asPeer(pid)
        var w = ReplayWindow.fresh()
        val first = Receive.decide(ok(1, MessageBody.Text("x")), peer, w, b.id) { null } as Inbound.Accepted
        w = first.window
        // repeated n with no history row -> invalid
        assertEquals(Inbound.Invalid(a.id), Receive.decide(ok(1, MessageBody.Text("x")), peer, w, b.id) { null })
        // repeated n with a history row -> re-present
        assertEquals(Inbound.RePresent(77), Receive.decide(ok(1, MessageBody.Text("x")), peer, w, b.id) { 77 })
        // control type seen -> silent duplicate
        val p = Receive.decide(ok(2, MessageBody.Pause), peer, w, b.id) { null } as Inbound.Accepted
        assertTrue(Receive.decide(ok(2, MessageBody.Pause), peer, p.window, b.id) { null } is Inbound.Duplicate)
        // n <= h - 100 -> invalid
        val far = Receive.decide(ok(300, MessageBody.Text("x")), peer, p.window, b.id) { null } as Inbound.Accepted
        assertEquals(Inbound.Invalid(a.id), Receive.decide(ok(200, MessageBody.Text("x")), peer, far.window, b.id) { 1 })
        assertEquals(Inbound.Invalid(a.id), Receive.decide(ok(150, MessageBody.Pause), peer, far.window, b.id) { null })
    }

    @Test fun acceptanceTable() {
        val approved = a.asPeer(pid)
        val unruled = approved.copy(approved = false, approveVerified = false)
        val w = ReplayWindow.fresh()
        fun eff(p: Peer, body: MessageBody, n: Long = 1) = (Receive.decide(ok(n, body), p, w, b.id) { null } as Inbound.Accepted).effect
        assertTrue(eff(approved, MessageBody.Url("https://x.com")) is Effect.Show)
        assertTrue(eff(unruled, MessageBody.Url("https://x.com")) is Effect.Drop)
        assertTrue(eff(approved.copy(deniedByMe = true), MessageBody.Text("x")) is Effect.Drop)
        assertTrue(eff(approved, MessageBody.Text("x".repeat(2049))) is Effect.Drop)
        val bad = eff(approved, MessageBody.Url("ftp://x")) as Effect.Show
        assertTrue(bad.content.showAsText)
        val tel = eff(approved, MessageBody.Tel("call me")) as Effect.Show
        assertTrue(tel.content.showAsText && !tel.content.canDial)
        val tel2 = eff(approved, MessageBody.Tel(" tel:+1 555-123-4567")) as Effect.Show
        assertEquals("+1 555-123-4567", tel2.content.value)
        assertTrue(tel2.content.canDial)

        val entry = NameEntry.buildClear(a.keys, a.id, b.id, pid, 3, "A")
        val ap = eff(approved, MessageBody.Approve(entry), 3) as Effect.Approve
        assertEquals("A", ap.name); assertTrue(ap.notify)
        val kept = eff(unruled, MessageBody.Approve(entry), 3) as Effect.Approve
        assertTrue(!kept.notify)
        assertTrue(eff(approved.copy(deniedByMe = true), MessageBody.Approve(entry), 3) is Effect.Drop)
        assertTrue(eff(approved, MessageBody.Approve(entry), 4) is Effect.Drop) // entry n != message n
        val otherPairing = NameEntry.buildClear(a.keys, a.id, b.id, ByteArray(8), 3, "A")
        assertTrue(eff(approved, MessageBody.Approve(otherPairing), 3) is Effect.Drop)

        val rn = eff(approved.copy(name = "A", nameN = 3), MessageBody.Rename(NameEntry.buildClear(a.keys, a.id, b.id, pid, 5, "B")), 5) as Effect.Rename
        assertEquals("A", rn.oldName); assertEquals("B", rn.newName); assertTrue(rn.applied)
        assertEquals(Effect.SelfRemoved(false), eff(approved, MessageBody.Remove(b.id)))
        assertEquals(Effect.Remove(a.id), eff(approved, MessageBody.Remove(a.id)))
        assertEquals(Effect.SelfRemoved(true), eff(approved, MessageBody.Delete))
        assertEquals(Effect.Pause(true, true), eff(approved, MessageBody.Pause, 4))
        assertEquals(Effect.Pause(false, false), eff(approved.copy(pauseN = 9), MessageBody.Unpause, 4))
        assertEquals(Effect.Deny, eff(approved, MessageBody.Deny))
        assertTrue(eff(unruled, MessageBody.Deny) is Effect.Drop)
    }
}
