package com.pusharmor.protocol.engine

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.protocol.JValue
import com.pusharmor.protocol.StrictJson

/** A minimal in-memory Worker for state-machine tests: relay, allow/deny/pending, logout gate. */
class FakeWorker {
    val account = ByteArray(9) { 0x21 }
    val devices = LinkedHashMap<String, Device>()

    inner class Device(val label: String) {
        val keys = SoftwareKeyOps.generate()
        val id: String = B64url.encode(account + Ids.keyhash(keys.signPub, keys.encPub) + ByteArray(9) { label.hashCode().toByte() })
        val me = Identity(keys, id)
        val store = MemStore(label)
        val effects = RecEffects()
        val inbox = ArrayList<String>()
        val allow = LinkedHashSet<String>()
        val deny = LinkedHashSet<String>()
        val pending = HashMap<String, String>()
        var loggedOut = false
        var skewNext = 0
        var rateLimitNext = 0
        var offline = false
        val calls = ArrayList<String>()
        private var rnd = 0
        val api = DeviceApi(this)
        val pairing = PairingEngine(store, me, api, effects) { n -> ByteArray(n) { (label.hashCode() + rnd++ * 31 + it).toByte() } }
        val approve = ApproveFlow(store, me, api, effects)
        val receive = ReceiveEngine(store, me, effects)
        val reconcile = AllowReconcile(store, api) { effects.log.add("selfRemovedPath") }
        val send = SendFlow(store, me, api, effects)
        val sync = PeersSync(store, me)

        fun fetch() { (api.peers() as ApiResult.Ok).value.let { sync.merge(it) } }

        /** Delivers queued pushes to this device. */
        fun deliver(now: Long, drop: Boolean = false): Int {
            val items = inbox.toList(); inbox.clear()
            if (drop) return items.size
            for (m in items) {
                if (m.length == 366) pairing.onPush(m, now) { fetch(); store.peer(it)?.listEncPub != null }
                else receive.onMessage(m, now)
            }
            return items.size
        }

        fun runPairSends(now: Long) { for (r in store.pairings()) pairing.sendPending(r.peerId, now) }
    }

    fun add(label: String): Device = Device(label).also { devices[it.id] = it }

    inner class DeviceApi(private val d: Device) : Api {
        private fun gate(name: String, allowLoggedOut: Boolean = false): ApiResult<Nothing>? {
            d.calls.add(name)
            if (d.offline) return ApiResult.Network
            if (d.skewNext > 0) { d.skewNext--; return ApiResult.Http(401, "clock skew") }
            if (d.rateLimitNext > 0) { d.rateLimitNext--; return ApiResult.Http(429, "rate limited", 60) }
            if (d.loggedOut && !allowLoggedOut) return ApiResult.Http(401, "logged out")
            return null
        }

        private fun relay(to: String, msg: String): String {
            val t = devices[to] ?: return "unknown"
            if (d.id in t.deny) return "denied"
            if (d.id !in t.allow) return "unapproved"
            if (t.loggedOut) return "logged out"
            t.inbox.add(msg)
            return "sent"
        }

        override fun send(messages: Map<String, String>): ApiResult<Map<String, String>> {
            gate("send")?.let { return it }
            return ApiResult.Ok(messages.mapValues { (to, m) -> relay(to, m) })
        }

        override fun approve(x: String, body: ByteArray): ApiResult<ApproveReply> {
            gate("approve")?.let { return it }
            val o = StrictJson.parse(String(body)) as JValue.JObject
            val c = (o.fields["c"] as JValue.JString).value
            val t = devices[x] ?: return ApiResult.Ok(ApproveReply("unknown"))
            if (d.id in t.deny) return ApiResult.Ok(ApproveReply("denied"))
            d.allow.add(x); d.deny.remove(x); d.pending[x] = c
            if (d.id !in t.allow) return ApiResult.Ok(ApproveReply("stored"))
            t.inbox.add(c)
            return ApiResult.Ok(ApproveReply("sent", t.pending[d.id]))
        }

        override fun deny(x: String, c: String): ApiResult<ApproveReply> {
            gate("deny")?.let { return it }
            d.deny.add(x); d.allow.remove(x); d.pending.remove(x)
            return ApiResult.Ok(ApproveReply(relay(x, c).let { if (it == "unapproved") "unapproved" else it }))
        }

        override fun withdraw(x: String): ApiResult<ApproveReply> {
            gate("withdraw:$x", allowLoggedOut = true)?.let { return it }
            d.allow.remove(x); d.pending.remove(x)
            return ApiResult.Ok(ApproveReply("unapproved"))
        }

        override fun pair(x: String, kind: String, c: String): ApiResult<String> {
            gate("pair:$kind")?.let { return it }
            val t = devices[x] ?: return ApiResult.Ok("unknown")
            if (d.id in t.deny) return ApiResult.Ok("denied")
            t.inbox.add(c)
            return ApiResult.Ok("sent")
        }

        override fun peers(): ApiResult<PeersReply> {
            gate("peers")?.let { return it }
            return ApiResult.Ok(PeersReply(null, d.allow.toList(), devices.values.map { p ->
                ListedPeer(p.id, B64url.encode(p.keys.signPub), B64url.encode(p.keys.encPub), "android", 1761300000, p.loggedOut, p.allow.size, 0,
                    d.id in p.allow, d.id in p.deny, true, null)
            }))
        }

        private fun mFor(messages: Map<String, String>): ApiResult<Nothing>? {
            val missing = d.allow.filter { it !in messages }
            return if (missing.isEmpty()) null else ApiResult.Http(400, "messages missing", ids = missing)
        }

        override fun logout(messages: Map<String, String>): ApiResult<Map<String, String>> {
            gate("logout")?.let { return it }
            mFor(messages)?.let { return it }
            val r = messages.mapValues { (to, m) -> relay(to, m) }
            d.loggedOut = true
            return ApiResult.Ok(r)
        }

        override fun login(ticket: String, messages: Map<String, String>): ApiResult<Map<String, String>> {
            gate("login", allowLoggedOut = true)?.let { return it }
            mFor(messages)?.let { return it }
            d.loggedOut = false
            return ApiResult.Ok(messages.mapValues { (to, m) -> relay(to, m) })
        }

        override fun rename(names: Map<String, String>, messages: Map<String, String>) = send(messages)
        override fun deletePeer(id: String, messages: Map<String, String>) = send(messages)
    }
}
