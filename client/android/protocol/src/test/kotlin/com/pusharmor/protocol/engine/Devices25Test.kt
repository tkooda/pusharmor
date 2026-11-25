package com.pusharmor.protocol.engine

import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.PairDecide
import com.pusharmor.protocol.PairState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** An account with 25 devices: this one and 24 others, all paired and approved. */
class Devices25Test {
    private val t0 = 1_761_300_000_000L
    private val w = FakeWorker()
    private val n = w.add("N")

    private fun pairAndApprove(x: FakeWorker.Device) {
        n.fetch(); x.fetch()
        assertEquals(PairStart.STARTED, n.pairing.tapPair(x.id, t0))
        n.runPairSends(t0); x.deliver(t0); x.runPairSends(t0); n.deliver(t0); n.runPairSends(t0); x.deliver(t0)
        assertEquals(PairState.SHOWN, n.store.pairing(x.id)!!.state)
        n.approve.approve(x.id); x.approve.approve(n.id); n.deliver(t0)
    }

    private fun others(count: Int): List<FakeWorker.Device> {
        val list = (1..count).map { w.add("X$it") }
        for (x in list) pairAndApprove(x)
        n.fetch(); for (x in list) x.fetch()
        assertEquals(list.map { it.id }.toSet(), n.deleteSync.targets().map { it.id }.toSet())
        return list
    }

    private fun sends() = n.calls.count { it == "send" }

    @Test fun aSendToAll24OthersIsOneCall() {
        val list = others(24)
        val before = sends()
        val r = n.send.send(list.map { it.id }, ContentType.TEXT, "hello", t0)
        assertEquals(24, r.sent)
        assertEquals(before + 1, sends())
        for (x in list) { x.deliver(t0); assertEquals(listOf("hello"), x.store.history.map { it.content }) }
    }

    @Test fun aSyncedDeleteTo24OthersIsOneCall() {
        val list = others(24)
        n.send.send(list.map { it.id }, ContentType.TEXT, "hello", t0)
        for (x in list) x.deliver(t0)
        val before = sends()
        val r = n.deleteSync.send(n.store.history.toList(), sync = true)!!
        assertNull(r.failed)
        assertEquals(before + 1, sends())
        assertEquals(list.map { it.id }.toSet(), r.accepted.values.single())
        for (x in list) { x.deliver(t0); assertEquals(emptyList<String?>(), x.store.history.map { it.content }) }
    }

    @Test fun aSyncedDeleteSplitsAt24PerCall() {
        assertEquals(24, DeleteSync.MAX_TARGETS)
        val list = others(25)
        n.send.send(list.map { it.id }, ContentType.TEXT, "hello", t0)
        val before = sends()
        val r = n.deleteSync.send(n.store.history.toList(), sync = true)!!
        assertNull(r.failed)
        assertEquals(before + 2, sends())
        assertEquals(25, r.accepted.values.single().size)
    }

    @Test fun pairingsFrom24DevicesAtOnceStayOpenAndThe25thIsDropped() {
        assertEquals(24, PairDecide.MAX_OPEN_ENTRIES)
        val senders = (1..25).map { w.add("S$it") }
        n.fetch()
        for (s in senders) { s.fetch(); s.pairing.tapPair(n.id, t0); s.runPairSends(t0); n.deliver(t0) }
        assertEquals(senders.take(24).map { it.id }.toSet(), n.store.pairings().map { it.peerId }.toSet())
        assertEquals(PairDecide.CAP, n.store.capTimestamps().size) // the automatic reply cap still holds
    }
}
