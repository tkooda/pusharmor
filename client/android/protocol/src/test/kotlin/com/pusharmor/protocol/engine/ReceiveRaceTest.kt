package com.pusharmor.protocol.engine

import com.pusharmor.protocol.Inbound
import com.pusharmor.protocol.InnerMessage
import com.pusharmor.protocol.MessageBody
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.TestPeer
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.BrokenBarrierException
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** I288: the window read, decide and write of one push happen in one transaction. */
class ReceiveRaceTest {
    /** Holds every window read until two readers arrive (or 300 ms pass), widening the race. */
    private class RacingStore(val inner: MemStore) : LocalStore by inner {
        val barrier = CyclicBarrier(2)
        override fun window(peerId: String): ReplayWindow? {
            try { barrier.await(300, TimeUnit.MILLISECONDS) } catch (_: TimeoutException) {} catch (_: BrokenBarrierException) {}
            return inner.window(peerId)
        }
    }

    @Test fun sameWireFromTwoThreadsIsAcceptedOnce() {
        val me = TestPeer()
        val sender = TestPeer()
        val pid = ByteArray(8) { 7 }
        val mem = MemStore()
        mem.putPeer(sender.asPeer(pid))
        mem.putWindow(sender.id, pid, ReplayWindow.fresh())
        val store = RacingStore(mem)
        val engine = ReceiveEngine(store, Identity(me.keys, me.id), object : Effects {})
        val wire = InnerMessage.build(sender.keys, sender.idRaw, me.id, me.keys.encPub, pid, 1, MessageBody.Text("hi"))
        val pool = Executors.newFixedThreadPool(2)
        val results = (0 until 2).map { pool.submit<Inbound> { engine.onMessage(wire, 1000) } }.map { it.get(10, TimeUnit.SECONDS) }
        pool.shutdown()
        assertEquals(1, results.count { it is Inbound.Accepted })
        assertEquals(1, mem.history.count { it.type == "text" })
    }
}
