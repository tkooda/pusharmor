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
        val r = receive.onMessage(wireOf("{\"n\":5,\"id\":\"abc_-9\",\"show\":true,\"future\":\"x\"}"), 1000)
        assertTrue(r is Inbound.Accepted)
        assertEquals(MessageBody.Unknown("future", "abc_-9"), (r as Inbound.Accepted).body)
        val row = store.history.single()
        assertEquals(HistoryRow.UNKNOWN, row.type)
        assertEquals("future", row.content)
        assertEquals("abc_-9", row.msgId)
        assertEquals(a.id, row.peerId)
        assertEquals(5L, row.n)
        assertTrue(effects.log.isEmpty())
        assertEquals(5L, store.window(a.id)!!.h)
        // a later del naming its id removes it like any message
        receive.onMessage(wireOf("{\"n\":6,\"del\":[\"abc_-9\"]}"), 1001)
        assertTrue(store.history.isEmpty())
    }

    /** A file shows as an unknown row (no notice) until this app shows files; a later del removes it. */
    @Test fun fileIsAnUnknownRowWithNoNotice() {
        val f = "{\"url\":\"https://b2file.pusharmor.com/v1/x\",\"expires\":1795405632,\"key\":\"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY\",\"name\":\"a.pdf\",\"size\":5,\"sha256\":\"n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg\"}"
        val r = receive.onMessage(wireOf("{\"v\":1,\"n\":5,\"id\":\"abc_-9\",\"show\":true,\"file\":$f}"), 1000)
        assertTrue(r is Inbound.Accepted)
        assertTrue((r as Inbound.Accepted).body is MessageBody.File)
        val row = store.history.single()
        assertEquals(HistoryRow.UNKNOWN, row.type)
        assertEquals("file", row.content)
        assertEquals("abc_-9", row.msgId)
        assertTrue(effects.log.isEmpty())
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
        val unknown = trace(true) { "\"future\":\"x\"" }
        // fresh, duplicate, and del: the only difference is that a text row notifies and an unknown row does not
        assertEquals(text.take(3).map { it.replace("show, ", "").replace("[show]", "[]").replace(", show]", "]") }, unknown.take(3))
        // stale (seen with no row, older than the window): text is Invalid, unknown is silent
        assertTrue(text.drop(3).all { it.startsWith("Invalid") })
        assertEquals(listOf("Ignored [] [represent, deleted]", "Ignored [] [represent, deleted]"), unknown.drop(3))
    }

    @Test fun unknownTypeWithShowAndAStaleNIsSilentAndKeepsTheWindow() {
        val show = { n: Int -> wireOf("{\"n\":$n,\"id\":\"abc\",\"show\":true,\"future\":\"x\"}") }
        val v2 = { n: Int -> wireOf("{\"v\":2,\"n\":$n,\"id\":\"abc\",\"show\":true,\"text\":\"x\"}") }
        receive.onMessage(show(150), 1000)
        receive.onMessage(wireOf("{\"n\":151,\"del\":[\"abc\"]}"), 1001)
        receive.onMessage(wireOf("{\"n\":152,\"future\":\"x\"}"), 1002)  // seen n that never had a row
        assertTrue(store.history.isEmpty())
        effects.log.clear()
        // seen n whose row was deleted, seen n with no row, and n older than the replay window
        for (wire in listOf(show(150), show(152), show(10), v2(150), v2(152), v2(10))) {
            assertTrue(receive.onMessage(wire, 2000) is Inbound.Ignored)
        }
        assertTrue(store.history.isEmpty())
        // only the newer version mark, no notice
        assertEquals(listOf("newer", "newer", "newer"), effects.log)
        assertEquals(152L, store.window(a.id)!!.h)
        assertEquals(ReplayWindow.Verdict.FRESH, store.window(a.id)!!.check(153))
    }

    @Test fun unknownTypeFromAPeerNotApprovedIsSilentAndKeepsTheWindow() {
        for (peer in listOf(a.asPeer(pid, approved = false), a.asPeer(pid).copy(deniedByMe = true))) {
            for (json in listOf("{\"n\":5,\"id\":\"abc\",\"show\":true,\"future\":\"x\"}", "{\"n\":5,\"future\":\"x\"}", "{\"v\":2,\"n\":5,\"id\":\"abc\",\"show\":true,\"text\":\"x\"}")) {
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
        assertTrue(receive.onMessage(wireOf("{\"n\":5,\"id\":\"a b\",\"show\":true,\"future\":\"x\"}"), 1000) is Inbound.Accepted)
        assertEquals(null, store.history.single().msgId)
        assertEquals(HistoryRow.UNKNOWN, store.history.single().type)
    }

    @Test fun unknownTypeWithoutShowIsIgnored() {
        for ((n, json) in listOf(6L to "{\"n\":6,\"future\":\"x\"}", 7L to "{\"n\":7,\"future\":\"x\",\"id\":\"abc_-9\"}", 8L to "{\"n\":8,\"future\":\"x\",\"id\":7}", 9L to "{\"n\":9,\"id\":\"abc\"}", 10L to "{\"n\":10,\"future\":\"x\",\"show\":1}")) {
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

    @Test fun newerVersionWithAStaleNSetsTheMarkFromAnApprovedPeerOnly() {
        val v2 = { n: Int -> wireOf("{\"v\":2,\"n\":$n,\"id\":\"abc\",\"show\":true,\"text\":\"x\"}") }
        val v2NoShow = { n: Int -> wireOf("{\"v\":2,\"n\":$n,\"id\":\"abc\",\"deny\":1}") }
        receive.onMessage(v2(150), 1000)  // a row
        receive.onMessage(wireOf("{\"n\":151,\"future\":\"x\"}"), 1001)  // seen n that never had a row
        // seen n with a row (re-present), seen n with no row, n older than the window; with and without show
        for (wire in listOf(v2(150), v2(151), v2(10), v2NoShow(151), v2NoShow(10))) {
            effects.log.clear()
            receive.onMessage(wire, 2000)
            assertTrue(effects.log.toString(), "newer" in effects.log)
        }
        assertEquals(151L, store.window(a.id)!!.h)
        // the same stale messages from a peer that is not approved do not set it
        for (peer in listOf(a.asPeer(pid, approved = false), a.asPeer(pid).copy(deniedByMe = true))) {
            store.putPeer(peer)
            for (wire in listOf(v2(150), v2(151), v2(10), v2NoShow(151), v2NoShow(10))) {
                effects.log.clear()
                receive.onMessage(wire, 2000)
                assertTrue(effects.log.toString(), "newer" !in effects.log)
            }
        }
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
