package com.pusharmor.app.push

import com.pusharmor.app.Graph
import com.pusharmor.protocol.PairMessage

/** One entry for every push (FCM data["m"] or UnifiedPush): pair messages by length, else inner messages. */
object PushDispatcher {
    fun onPush(g: Graph, m: String?, fcm: Boolean) {
        if (g.identity() == null) return // signed out of keys: nothing can be read
        val now = System.currentTimeMillis()
        if (m == null) { g.effects(fcm).couldNotRead(); return }
        if (m.length == PairMessage.WIRE_CHARS) {
            g.pairing(fcm).onPush(m, now) { id -> g.session.fetchPeers(force = true); g.store.peer(id)?.listEncPub != null }
        } else {
            g.receive(fcm).onMessage(m, now)
        }
        g.session.purgeHistory()
    }
}
