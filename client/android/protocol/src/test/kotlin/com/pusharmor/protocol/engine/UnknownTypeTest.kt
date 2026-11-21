package com.pusharmor.protocol.engine

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Hpke
import com.pusharmor.protocol.DeflateRaw
import com.pusharmor.protocol.Inbound
import com.pusharmor.protocol.InnerMessage
import com.pusharmor.protocol.MessageBody
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.TestPeer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A verified message with no known type key is ignored silently; unreadable input still shows. */
class UnknownTypeTest {
    private val me = TestPeer()
    private val a = TestPeer()
    private val pid = ByteArray(8) { 7 }
    private val store = MemStore()
    private val effects = RecEffects()
    private val receive = ReceiveEngine(store, Identity(me.keys, me.id), effects)

    init {
        store.putPeer(a.asPeer(pid))
        store.putWindow(a.id, pid, ReplayWindow.fresh())
    }

    private fun wireOf(json: String, tamper: Boolean = false): String {
        val deflated = DeflateRaw.deflate(json.toByteArray(Charsets.UTF_8))
        val body = InnerMessage.buildBodyFromDeflated(a.idRaw, pid, deflated, null, 512)
        val sig = a.keys.sign(InnerMessage.signedBytes(me.id, body))
        if (tamper) sig[0] = (sig[0].toInt() xor 1).toByte()
        val sealed = Hpke().seal(me.keys.encPub, Hpke.INFO_MSG, me.id.toByteArray(Charsets.US_ASCII), sig + body)
        return B64url.encode(sealed)
    }

    @Test fun validSignedUnknownTypeIsSilentAndConsumesN() {
        val r = receive.onMessage(wireOf("{\"n\":5,\"zzz\":\"x\"}"), 1000)
        assertTrue(r is Inbound.Ignored)
        assertTrue(store.history.isEmpty())
        assertTrue(effects.log.isEmpty())
        assertEquals(5L, store.window(a.id)!!.h)
        // same n again: still silent
        assertTrue(receive.onMessage(wireOf("{\"n\":5,\"zzz\":\"x\"}"), 1001) is Inbound.Ignored)
        assertTrue(store.history.isEmpty())
        assertTrue(effects.log.isEmpty())
    }

    @Test fun unknownTypeWithShowIsAContentRowWithNoNotice() {
        val r = receive.onMessage(wireOf("{\"n\":5,\"id\":\"abc_-9\",\"show\":true,\"file\":\"x\"}"), 1000)
        assertTrue(r is Inbound.Accepted)
        assertEquals(MessageBody.Unknown("file", "abc_-9"), (r as Inbound.Accepted).body)
        val row = store.history.single()
        assertEquals(HistoryRow.UNKNOWN, row.type)
        assertEquals("file", row.content)
        assertEquals("abc_-9", row.msgId)
        assertEquals(a.id, row.peerId)
        assertEquals(5L, row.n)
        assertTrue(effects.log.isEmpty())
        assertEquals(5L, store.window(a.id)!!.h)
        // a later del naming its id removes it like any message
        receive.onMessage(wireOf("{\"n\":6,\"del\":[\"abc_-9\"]}"), 1001)
        assertTrue(store.history.isEmpty())
    }

    /** Runs one received sequence on a fresh store; returns per step the inbound kind, History rows and notices. */
    private fun trace(approved: Boolean, body: (Int) -> String): List<String> {
        val st = MemStore()
        val ef = RecEffects()
        val rx = ReceiveEngine(st, Identity(me.keys, me.id), ef)
        st.putPeer(a.asPeer(pid, approved = approved))
        st.putWindow(a.id, pid, ReplayWindow.fresh())
        fun row(h: HistoryRow) = listOf(h.direction, h.peerId, h.n, h.read, h.count, h.msgId, h.type == "unreadable" || h.type == "invalid").toString()
        val out = ArrayList<String>()
        fun step(n: Long, i: Int) {
            val r = rx.onMessage(wireOf("{\"n\":$n,${body(i)},\"id\":\"id$i\",\"show\":true}"), 1000L + n)
            out.add("${r::class.simpleName} ${st.history.map(::row)} ${ef.log.map { it.substringBefore(":") }}")
        }
        step(150, 1)  // fresh: unread row
        step(150, 1)  // duplicate with its row
        rx.onMessage(wireOf("{\"n\":151,\"del\":[\"id1\"]}"), 2000); out.add("del ${st.history.map(::row)}")
        step(150, 1)  // duplicate whose row was deleted
        step(10, 2)   // older than the replay window
        return out
    }

    @Test fun unknownTypeWithShowFollowsTheTextPath() {
        val text = trace(true) { "\"text\":\"x\"" }
        val unknown = trace(true) { "\"file\":\"x\"" }
        // the only difference: a text row notifies, an unknown row does not
        assertEquals(text.map { it.replace("show, ", "").replace("[show]", "[]").replace(", show]", "]") }, unknown)
    }

    @Test fun unknownTypeFromAPeerNotApprovedIsSilentAndKeepsTheWindow() {
        for (peer in listOf(a.asPeer(pid, approved = false), a.asPeer(pid).copy(deniedByMe = true))) {
            for (json in listOf("{\"n\":5,\"id\":\"abc\",\"show\":true,\"file\":\"x\"}", "{\"n\":5,\"file\":\"x\"}", "{\"v\":2,\"n\":5,\"id\":\"abc\",\"show\":true,\"text\":\"x\"}")) {
                val st = MemStore()
                val ef = RecEffects()
                val rx = ReceiveEngine(st, Identity(me.keys, me.id), ef)
                st.putPeer(peer)
                st.putWindow(a.id, pid, ReplayWindow.fresh())
                assertTrue(json, rx.onMessage(wireOf(json), 1000) is Inbound.Ignored)
                assertTrue(json, st.history.isEmpty())
                assertTrue(json, ef.log.isEmpty())
                assertEquals(json, ReplayWindow.fresh().h, st.window(a.id)!!.h)
                assertEquals(json, ReplayWindow.Verdict.FRESH, st.window(a.id)!!.check(5))
            }
        }
    }

    @Test fun unknownTypeWithShowAndNoValidIdIsARowWithNoMessageId() {
        assertTrue(receive.onMessage(wireOf("{\"n\":5,\"id\":\"a b\",\"show\":true,\"file\":\"x\"}"), 1000) is Inbound.Accepted)
        assertEquals(null, store.history.single().msgId)
        assertEquals(HistoryRow.UNKNOWN, store.history.single().type)
    }

    @Test fun unknownTypeWithoutShowIsIgnored() {
        for ((n, json) in listOf(6L to "{\"n\":6,\"file\":\"x\"}", 7L to "{\"n\":7,\"file\":\"x\",\"id\":\"abc_-9\"}", 8L to "{\"n\":8,\"file\":\"x\",\"id\":7}", 9L to "{\"n\":9,\"id\":\"abc\"}", 10L to "{\"n\":10,\"file\":\"x\",\"show\":1}")) {
            assertTrue(json, receive.onMessage(wireOf(json), 1000) is Inbound.Ignored)
            assertEquals(n, store.window(a.id)!!.h)
        }
        assertTrue(store.history.isEmpty())
        assertTrue(effects.log.isEmpty())
    }

    @Test fun newerVersionWithShowIsAnUnknownRowAndSetsTheMark() {
        val r = receive.onMessage(wireOf("{\"v\":2,\"n\":5,\"id\":\"abc_-9\",\"show\":true,\"text\":\"x\"}"), 1000)
        assertEquals(MessageBody.Unknown("text", "abc_-9", newer = true), (r as Inbound.Accepted).body)
        val row = store.history.single()
        assertEquals(HistoryRow.UNKNOWN, row.type)
        assertEquals("abc_-9", row.msgId)
        assertEquals(false, row.read)
        assertEquals(listOf("newer"), effects.log)
        assertEquals(5L, store.window(a.id)!!.h)
    }

    @Test fun newerVersionWithoutShowIsNoRowButSetsTheMark() {
        assertTrue(receive.onMessage(wireOf("{\"v\":2,\"n\":5,\"id\":\"abc_-9\",\"deny\":1}"), 1000) is Inbound.Ignored)
        assertTrue(store.history.isEmpty())
        assertEquals(listOf("newer"), effects.log)
        assertEquals(5L, store.window(a.id)!!.h)
    }

    @Test fun newerVersionFromAnUnapprovedPeerDoesNotSetTheMark() {
        store.putPeer(a.asPeer(pid, approved = false))
        receive.onMessage(wireOf("{\"v\":2,\"n\":5,\"id\":\"abc_-9\",\"deny\":1}"), 1000)
        receive.onMessage(wireOf("{\"v\":2,\"n\":6,\"id\":\"abc_-9\",\"show\":true,\"text\":\"x\"}"), 1000)
        assertTrue("newer" !in effects.log)
        // the same peer once approved sets it
        store.putPeer(a.asPeer(pid))
        receive.onMessage(wireOf("{\"v\":2,\"n\":7,\"id\":\"abc_-9\",\"deny\":1}"), 1000)
        assertTrue("newer" in effects.log)
    }

    @Test fun controlWithIdIsThatControl() {
        receive.onMessage(wireOf("{\"v\":1,\"n\":5,\"id\":\"abc_-9\",\"logout\":1}"), 1000).let { assertEquals(MessageBody.Logout, (it as Inbound.Accepted).body) }
        assertTrue(store.history.none { it.type == HistoryRow.UNKNOWN })
        assertTrue("newer" !in effects.log)
    }

    @Test fun unreadableStillShowsRowAndNotice() {
        for (wire in listOf(wireOf("not json"), wireOf("{\"zzz\":\"x\"}"), wireOf("{\"n\":5,\"zzz\":\"x\"}", tamper = true), "AAAA")) {
            store.history.clear(); effects.log.clear()
            assertTrue(receive.onMessage(wire, 1000) is Inbound.Unreadable)
            assertEquals(listOf("unreadable"), store.history.map { it.type })
            assertTrue(effects.log.contains("couldNotRead"))
        }
    }
}
