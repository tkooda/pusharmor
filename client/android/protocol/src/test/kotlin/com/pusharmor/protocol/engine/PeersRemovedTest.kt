package com.pusharmor.protocol.engine

import com.pusharmor.protocol.Inbound
import com.pusharmor.protocol.InnerMessage
import com.pusharmor.protocol.MessageBody
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.TestPeer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** GET /peers "removed": stored sealed remove(B) messages opened quietly like a live push. */
class PeersRemovedTest {
    private val me = TestPeer()
    private val a = TestPeer()
    private val b = TestPeer()
    private val pidA = ByteArray(8) { 7 }
    private val pidB = ByteArray(8) { 9 }
    private val store = MemStore()
    private val effects = RecEffects()
    private val identity = Identity(me.keys, me.id)
    private val receive = ReceiveEngine(store, identity, effects)
    private val sync = PeersSync(store, identity, effects)

    init {
        store.putPeer(a.asPeer(pidA))
        store.putWindow(a.id, pidA, ReplayWindow.fresh())
        store.putPeer(b.asPeer(pidB))
        store.putWindow(b.id, pidB, ReplayWindow.fresh())
    }

    private fun removeMsg(from: TestPeer, target: String, n: Long, pid: ByteArray = pidA) =
        InnerMessage.build(from.keys, from.idRaw, me.id, me.keys.encPub, pid, n, MessageBody.Remove(target))

    private fun reply(removed: Map<String, String>) = PeersReply(null, emptyList(), emptyList(), removed)

    @Test fun fetchedRemoveAppliesAndBIsNotMissing() {
        sync.merge(reply(mapOf(b.id to removeMsg(a, b.id, 1))), 1000)
        val p = store.peer(b.id)!!
        assertTrue(p.removed)
        assertFalse(p.missing)
        assertFalse(p.pinned)
        assertTrue(store.history.isEmpty())
    }

    @Test fun liveDuplicateOfAppliedFetchedRemoveIsSilentNoOp() {
        val wire = removeMsg(a, b.id, 1)
        sync.merge(reply(mapOf(b.id to wire)), 1000)
        assertTrue(receive.onMessage(wire, 1000) is Inbound.Duplicate)
        assertTrue(store.peer(b.id)!!.removed)
        assertTrue(store.history.isEmpty())
        assertFalse(effects.log.contains("invalid"))
    }

    @Test fun fetchedAfterLivePushIsIgnoredSilently() {
        val wire = removeMsg(a, b.id, 1)
        receive.onMessage(wire, 1000)
        effects.log.clear()
        sync.merge(reply(mapOf(b.id to wire)), 1000)
        assertTrue(store.peer(b.id)!!.removed)
        assertTrue(effects.log.isEmpty())
        assertTrue(store.history.isEmpty())
    }

    @Test fun tamperedEntryIsIgnoredSilentlyAndBGoesMissing() {
        val wire = removeMsg(a, b.id, 1)
        val bad = wire.substring(0, wire.length - 4) + (if (wire.endsWith("AAAA")) "BBBB" else "AAAA")
        sync.merge(reply(mapOf(b.id to bad)), 1000)
        assertTrue(store.peer(b.id)!!.missing)
        assertFalse(store.peer(b.id)!!.removed)
        assertTrue(effects.log.isEmpty())
        assertTrue(store.history.isEmpty())
    }

    @Test fun unknownSignerEntryIsIgnoredSilentlyAndBGoesMissing() {
        val stranger = TestPeer()
        sync.merge(reply(mapOf(b.id to removeMsg(stranger, b.id, 1))), 1000)
        assertTrue(store.peer(b.id)!!.missing)
        assertTrue(effects.log.isEmpty())
        assertTrue(store.history.isEmpty())
    }

    @Test fun removeNamingAnotherPeerIsIgnored() {
        val c = TestPeer()
        sync.merge(reply(mapOf(b.id to removeMsg(a, c.id, 1))), 1000)
        assertTrue(store.peer(b.id)!!.missing)
        assertFalse(store.peer(b.id)!!.removed)
    }
}
