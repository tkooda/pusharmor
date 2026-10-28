package com.pusharmor.app.push

import com.pusharmor.app.Graph
import com.pusharmor.protocol.PairMessage

/** One entry for every push (FCM data["m"] or UnifiedPush): pair messages by length, else inner messages. */
object PushDispatcher {
    fun onPush(g: Graph, m: String?, fcm: Boolean) {
        val now = System.currentTimeMillis()
        guard({ g.effects(fcm).couldNotRead() }) {
            if (g.identity() == null) return@guard // signed out of keys: nothing can be read
            if (m == null) { g.effects(fcm).couldNotRead(); return@guard }
            if (m.length == PairMessage.WIRE_CHARS) {
                g.pairing(fcm).onPush(m, now) { id -> g.session.fetchPeers(force = true, inPush = true); g.store.peer(id)?.listEncPub != null }
            } else {
                g.receive(fcm).onMessage(m, now)
            }
            g.session.purgeHistory()
        }
    }

    /** Any failure in the handler drops the push with the generic notice instead of crashing (I299). */
    fun guard(onFail: () -> Unit, block: () -> Unit) {
        try { block() } catch (e: Exception) { onFail() }
    }
}
