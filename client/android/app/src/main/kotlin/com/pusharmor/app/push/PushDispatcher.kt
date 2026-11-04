package com.pusharmor.app.push

import com.pusharmor.app.Graph
import com.pusharmor.protocol.JValue
import com.pusharmor.protocol.PairMessage
import com.pusharmor.protocol.StrictJson

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
            g.session.updateShortcuts() // a pairing that completed here becomes a direct share target at once
            g.session.purgeHistory()
        }
    }

    /** The relay server's test push (Check again), dropped silently: FCM data {"check":"1"}. */
    fun isCheck(fcmData: Map<String, String>): Boolean = fcmData["check"] == "1"

    /** The relay server's test push (Check again), dropped silently: UnifiedPush body {"check":1}. */
    fun isCheck(body: String): Boolean =
        ((StrictJson.parseOrNull(body) as? JValue.JObject)?.fields?.get("check") as? JValue.JNumber)?.raw == "1"

    /** Any failure in the handler drops the push with the generic notice instead of crashing; a failing notice is dropped too. */
    fun guard(onFail: () -> Unit, block: () -> Unit) {
        try { block() } catch (e: Exception) { try { onFail() } catch (_: Exception) {} }
    }
}
