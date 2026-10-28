package com.pusharmor.store

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.protocol.PairKind
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.engine.Direction
import com.pusharmor.protocol.engine.HistoryRow
import com.pusharmor.protocol.engine.PairingRow
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

@RunWith(RobolectricTestRunner::class)
class RoomLocalStoreTest {
    private val ctx = ApplicationProvider.getApplicationContext<Context>()

    @Test fun counterReservedFromTwoDatabaseInstancesIsDistinct() {
        // Two Room instances on the same file stand in for two processes sharing the store.
        val a = RoomLocalStore(Room.databaseBuilder(ctx, PaDatabase::class.java, "c.db").enableMultiInstanceInvalidation().allowMainThreadQueries().build())
        val b = RoomLocalStore(Room.databaseBuilder(ctx, PaDatabase::class.java, "c.db").enableMultiInstanceInvalidation().allowMainThreadQueries().build())
        a.putPeer(Peer(id = "p"))
        val pool = Executors.newFixedThreadPool(8)
        val got = java.util.Collections.synchronizedList(ArrayList<Long>())
        val latch = CountDownLatch(100)
        repeat(100) { i -> pool.execute { got.add((if (i % 2 == 0) a else b).reserveCounter("p")); latch.countDown() } }
        latch.await(); pool.shutdown()
        assertEquals(100, got.toSet().size)
        assertEquals(100L, a.peer("p")!!.lastN)
    }

    @Test fun putPeerKeepsStoredCounterAndResetClearsIt() {
        val s = RoomLocalStore(Room.databaseBuilder(ctx, PaDatabase::class.java, "k.db").allowMainThreadQueries().build())
        s.putPeer(Peer(id = "p"))
        val stale = s.peer("p")!!
        assertEquals(1L, s.reserveCounter("p"))
        s.putPeer(stale.copy(hidden = true))
        assertEquals(1L, s.peer("p")!!.lastN)
        s.resetCounter("p")
        assertEquals(0L, s.peer("p")!!.lastN)
    }

    @Test fun pairingRowSurvivesReopen() {
        val db1 = Room.databaseBuilder(ctx, PaDatabase::class.java, "p.db").allowMainThreadQueries().build()
        val s1 = RoomLocalStore(db1)
        s1.putPeer(Peer(id = "x"))
        s1.putPairing(PairingRow("x", PairRole.X, PairState.REPLIED, ByteArray(32) { 3 }, ByteArray(32) { 4 }, startedAt = 1000, pendingKind = PairKind.REPLY, pendingMessage = "m", authorized = true))
        s1.addCapTimestamp(5)
        db1.close()
        val s2 = RoomLocalStore(Room.databaseBuilder(ctx, PaDatabase::class.java, "p.db").allowMainThreadQueries().build())
        val r = s2.pairing("x")!!
        assertEquals(PairState.REPLIED, r.state)
        assertArrayEquals(ByteArray(32) { 3 }, r.r)
        assertEquals(PairKind.REPLY, r.pendingKind)
        assertEquals(listOf(5L), s2.capTimestamps())
        s2.deletePairing("x")
        assertNull(s2.pairing("x"))
    }

    @Test fun replayHistoryMergeAndWipeKeepsHistory() {
        val s = RoomLocalStore(Room.inMemoryDatabaseBuilder(ctx, PaDatabase::class.java).allowMainThreadQueries().build())
        s.putPeer(Peer(id = "x", pairingId = ByteArray(8)))
        val w = ReplayWindow.fresh().accept(3).accept(1)
        s.putWindow("x", ByteArray(8), w)
        assertArrayEquals(w.bitmapBytes(), s.window("x")!!.bitmapBytes())
        val a = s.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = null, type = "unreadable", at = 1))
        val b = s.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = null, type = "unreadable", at = 2))
        assertEquals(a, b)
        assertEquals(2, s.dao.history(a)!!.count)
        val m = s.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = "x", type = "text", content = "hi", n = 1, pairingId = ByteArray(8), at = 3, results = mapOf("a" to "sent")))
        assertEquals(m, s.historyIdFor("x", ByteArray(8), 1))
        assertEquals(mapOf("a" to "sent"), s.dao.history(m)!!.toRow().results)
        s.addAllow("x"); s.addCapTimestamp(1)
        s.wipeRegistration()
        assertNull(s.peer("x")); assertNull(s.window("x"))
        assertEquals(emptySet<String>(), s.allowSet())
        assertEquals(emptyList<Long>(), s.capTimestamps())
        assertEquals("hi", s.dao.history(m)!!.content) // history kept
    }
}
