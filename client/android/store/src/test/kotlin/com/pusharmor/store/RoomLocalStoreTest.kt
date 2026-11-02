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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

@RunWith(RobolectricTestRunner::class)
class RoomLocalStoreTest {
    private val ctx = ApplicationProvider.getApplicationContext<Context>()

    @Test fun appDatabaseRefusesMainThreadReads() {
        // Robolectric runs the test on the main thread. Screens read through flows or Dispatchers.IO.
        val db = PaDatabase.open(ctx, null)
        assertTrue(runCatching { db.dao().self() }.exceptionOrNull() is IllegalStateException)
        db.close()
    }

    @Test fun cliPlatformAndListeningRoundTrip() {
        val s = RoomLocalStore(Room.inMemoryDatabaseBuilder(ctx, PaDatabase::class.java).allowMainThreadQueries().build())
        s.putPeer(Peer(id = "p", platform = "cli", listening = false))
        assertEquals("cli", s.peer("p")!!.platform)
        assertEquals(false, s.peer("p")!!.listening)
        s.putPeer(s.peer("p")!!.copy(listening = true))
        assertEquals(true, s.peer("p")!!.listening)
    }

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

    @Test fun addingACapStampDropsStampsLaterThanIt() {
        val s = RoomLocalStore(Room.inMemoryDatabaseBuilder(ctx, PaDatabase::class.java).allowMainThreadQueries().build())
        s.addCapTimestamp(1_000_000)
        s.addCapTimestamp(1_000)
        assertEquals(listOf(1_000L), s.capTimestamps())
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

    @Test fun updatePeerSwitchesKeepsCounter() {
        val db = Room.databaseBuilder(ctx, PaDatabase::class.java, "u.db").allowMainThreadQueries().build()
        val s = RoomLocalStore(db)
        s.putPeer(Peer(id = "p"))
        repeat(5) { s.reserveCounter("p") }
        db.dao().updatePeerSwitches("p", lock = false, watch = null, show = null)
        val p = db.dao().peer("p")!!
        assertEquals(5L, p.lastN)
        assertEquals(false, p.lockScreen)
        assertEquals(true, p.watch)
        assertEquals(true, p.showContent)
    }

    @Test fun peerSettersChangeOnlyTheirColumn() {
        val db = Room.databaseBuilder(ctx, PaDatabase::class.java, "v.db").allowMainThreadQueries().build()
        val s = RoomLocalStore(db)
        s.putPeer(Peer(id = "p"))
        db.dao().setHidden("p", true)
        db.dao().setChannelId("p", "ch1")
        db.dao().updatePeerSwitches("p", lock = null, watch = false, show = false)
        val p = db.dao().peer("p")!!
        assertEquals(true, p.hidden)
        assertEquals("ch1", p.channelId)
        assertEquals(true, p.lockScreen)
        assertEquals(false, p.watch)
        assertEquals(false, p.showContent)
    }

    @Test fun selfSettersLeaveOtherColumns() {
        val db = Room.databaseBuilder(ctx, PaDatabase::class.java, "w.db").allowMainThreadQueries().build()
        db.dao().putSelf(SelfEntity(id = "s", accountPrefix = ByteArray(9), name = "old", email = "a@b.c"))
        db.dao().setClockOffset(42)
        db.dao().setSelfName("new")
        db.dao().setPushHash("h")
        db.dao().setSelfEmail("d@e.f")
        val self = db.dao().self()!!
        assertEquals(42L, self.clockOffset)
        assertEquals("new", self.name)
        assertEquals("h", self.pushHash)
        assertEquals("d@e.f", self.email)
        assertEquals("s", self.id)
    }

    @Test fun historyKeepsTheNewest500ByReceivedTime() {
        val s = RoomLocalStore(Room.inMemoryDatabaseBuilder(ctx, PaDatabase::class.java).allowMainThreadQueries().build())
        for (i in 1..519) s.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = "x", type = "text", content = "m$i", at = 1000L + i))
        // Inserted last but received first: it is the oldest, so it goes.
        val late = s.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = "x", type = "text", content = "late", at = 5))
        val kept = s.db.query("SELECT received_at FROM history ORDER BY received_at", null).use { c ->
            buildList { while (c.moveToNext()) add(c.getLong(0)) }
        }
        assertEquals(500, kept.size)
        assertNull(s.dao.history(late))
        assertEquals((1020L..1519L).toList(), kept)
    }

    @Test fun historyLookupsUseIndexes() {
        val s = RoomLocalStore(Room.inMemoryDatabaseBuilder(ctx, PaDatabase::class.java).allowMainThreadQueries().build())
        fun plan(sql: String, vararg args: Any) = s.db.query("EXPLAIN QUERY PLAN $sql", args).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(3)) }.joinToString(" | ")
        }
        val byId = plan("SELECT id FROM history WHERE peer_id = ? AND pairing_id = ? AND n = ? LIMIT 1", "p", ByteArray(8), 1L)
        assertTrue(byId, byId.contains("index_history_peer_id_pairing_id_n"))
        val ordered = plan("SELECT * FROM history ORDER BY received_at DESC, id DESC LIMIT 1")
        assertTrue(ordered, ordered.contains("index_history_received_at") && !ordered.contains("TEMP B-TREE"))
    }
}
