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

    @Test fun unreadableStillShowsRowAndNotice() {
        for (wire in listOf(wireOf("not json"), wireOf("{\"zzz\":\"x\"}"), wireOf("{\"n\":5,\"zzz\":\"x\"}", tamper = true), "AAAA")) {
            store.history.clear(); effects.log.clear()
            assertTrue(receive.onMessage(wire, 1000) is Inbound.Unreadable)
            assertEquals(listOf("unreadable"), store.history.map { it.type })
            assertTrue(effects.log.contains("couldNotRead"))
        }
    }
}
