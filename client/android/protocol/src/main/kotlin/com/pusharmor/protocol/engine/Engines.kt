package com.pusharmor.protocol.engine

import com.pusharmor.crypto.B64url
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Effect
import com.pusharmor.protocol.Inbound
import com.pusharmor.protocol.InnerMessage
import com.pusharmor.protocol.MessageBody
import com.pusharmor.protocol.NameEntry
import com.pusharmor.protocol.OpenResult
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.PeerList
import com.pusharmor.protocol.PinnedKeys
import com.pusharmor.protocol.Receive
import com.pusharmor.protocol.ReceivePipeline
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.allSet

/** Builds inner messages for pinned peers; reserves the counter BEFORE encrypt. */
class Outbox(private val store: LocalStore, private val me: Identity) {
    class Built(val message: String, val n: Long, val nameEntry: String? = null)

    /** [nameFor]: builds the body that carries a name entry with the same n (approve / rename). */
    fun build(peer: Peer, body: (n: Long) -> MessageBody): Built {
        val encPub = B64url.decode(peer.encPub ?: error("not pinned"))
        val pid = peer.pairingId ?: error("not pinned")
        val n = store.reserveCounter(peer.id) // committed before any encrypt or network call
        val b = body(n)
        val msg = InnerMessage.build(me.keys, me.idRaw, peer.id, encPub, pid, n, b)
        val entry = (b as? MessageBody.Approve)?.entry ?: (b as? MessageBody.Rename)?.entry
        return Built(msg, n, entry?.let { NameEntry.seal(it, peer.id, encPub) })
    }

    fun nameEntry(peer: Peer, n: Long) =
        NameEntry.buildClear(me.keys, me.id, peer.id, peer.pairingId!!, n, store.ownName())

    fun approve(peer: Peer): Built = build(peer) { n -> MessageBody.Approve(nameEntry(peer, n)) }

    fun rename(peer: Peer): Built = build(peer) { n -> MessageBody.Rename(nameEntry(peer, n)) }

    fun simple(peer: Peer, body: MessageBody): Built = build(peer) { body }
}

/** 401 "clock skew": the Worker relayed nothing; rebuild (new n) and retry once; a second one stops. */
object ClockSkew {
    const val CLOCK_OFF = "This device's clock is off by more than 5 minutes."

    fun <B, T> run(build: () -> B, call: (B) -> ApiResult<T>): ApiResult<T> {
        val first = call(build())
        if (!first.isClockSkew) return first
        return call(build()) // a second clock skew is returned as is; the UI shows CLOCK_OFF
    }
}

/** Send of url / text / tel to recipients (section 4 send pipeline). */
class SendFlow(private val store: LocalStore, me: Identity, private val api: Api, private val effects: Effects) {
    private val outbox = Outbox(store, me)

    class Outcome(val results: Map<String, String>, val total: Int, val error: ApiResult<*>? = null) {
        val sent: Int get() = results.values.count { it == "sent" }
    }

    fun send(recipientIds: List<String>, type: ContentType, value: String, now: Long): Outcome {
        val total = allSet(store.peers()).size
        val peers = recipientIds.mapNotNull { store.peer(it) }.filter { it.pinned }
        val body = MessageBody.content(type, value)
        val r = ClockSkew.run({ peers.associate { it.id to outbox.simple(it, body).message } }) { api.send(it) }
        return when (r) {
            is ApiResult.Ok -> {
                store.insertHistory(HistoryRow(direction = Direction.SENT, peerId = null, type = type.key, content = value, at = now, read = true, results = r.value))
                handleResults(r.value)
                Outcome(r.value, total)
            }
            else -> Outcome(emptyMap(), total, r)
        }
    }

    /**
     * "unapproved", "unknown", "gone", "logged out", "not listening" -> coalesced GET /peers;
     * "logged out" also sets peers.logged_out, "not listening" clears peers.listening.
     */
    fun handleResults(results: Map<String, String>) {
        var fetch = false
        for ((id, res) in results) {
            if (res in setOf("unapproved", "unknown", "gone", "logged out", "not listening")) fetch = true
            if (res == "logged out") store.peer(id)?.let { store.putPeer(it.copy(loggedOut = true)) }
            if (res == "not listening") store.peer(id)?.let { store.putPeer(it.copy(listening = false)) }
        }
        if (fetch) effects.fetchPeersSoon()
    }
}

/** Allow reconcile (I277, I278): withdraw every id of the allow set that has no pin here. */
class AllowReconcile(private val store: LocalStore, private val api: Api, private val onSelfRemoved: () -> Unit) {
    /** Returns false when the run stopped on 401 "unknown peer" (self-removed path taken). */
    fun run(): Boolean {
        for (id in store.allowSet()) {
            if (store.peer(id)?.pinned == true) continue // never withdraw a pinned id
            when (val r = api.withdraw(id)) {
                is ApiResult.Ok -> store.removeAllow(id)
                is ApiResult.Http -> when {
                    r.isUnknownPeer -> { onSelfRemoved(); return false }
                    r.status == 400 -> store.removeAllow(id)
                    else -> Unit // 429, 5xx, other 401: keep, the next run retries
                }
                ApiResult.Network -> Unit
            }
        }
        return true
    }

    /**
     * Runs [call]; on 400 "messages missing" adds the named ids to the allow set, reconciles,
     * and retries the call once ([call] rebuilds its m from the current allow set).
     */
    fun <T> withMissingRetry(call: () -> ApiResult<T>): ApiResult<T> {
        val r = call()
        if (!r.isMessagesMissing) return r
        (r as ApiResult.Http).ids.forEach { store.addAllow(it) }
        if (!run()) return r
        return call()
    }
}

/** Approve, deny and the re-fetch while waiting (catalog Approvals, I265, I280). */
class ApproveFlow(
    private val store: LocalStore,
    private val me: Identity,
    private val api: Api,
    private val effects: Effects,
) {
    private val outbox = Outbox(store, me)

    /** One Approve tap. Returns the API result for the UI (429 countdown, results). */
    fun approve(peerId: String): ApiResult<ApproveReply> {
        val peer = store.peer(peerId) ?: return ApiResult.Http(400, "bad request")
        if (!peer.pinned) return ApiResult.Http(400, "bad request")
        store.addAllow(peerId) // BEFORE the POST
        val r = ClockSkew.run({ buildApprove(peerId) }) { body -> api.approve(peerId, body) }
        return applyApproveResult(peerId, r)
    }

    private fun buildApprove(peerId: String): ByteArray {
        val peer = store.peer(peerId)!!
        val built = outbox.approve(peer)
        val body = Api.approveBody(built.message, built.nameEntry!!)
        store.tx {
            store.peer(peerId)?.let {
                store.putPeer(it.copy(approved = true, deniedByMe = false, storedApprove = String(body, Charsets.UTF_8), storedApproveName = store.ownName()))
            }
        }
        return body
    }

    private fun applyApproveResult(peerId: String, r: ApiResult<ApproveReply>): ApiResult<ApproveReply> {
        if (r is ApiResult.Ok) {
            store.tx { store.peer(peerId)?.let { store.putPeer(it.copy(lastApproveResult = r.value.result)) } }
            if (r.value.result == "denied") store.peer(peerId)?.let { store.putPeer(it.copy(declined = true)) }
            r.value.c?.let { verifyReturned(peerId, it) }
            // X's approve may have verified earlier (kept while unruled): the entry ends now.
            store.tx {
                val p = store.peer(peerId)
                if (p != null && p.approved && p.approveVerified) store.pairing(peerId)?.let { it.r.fill(0); store.deletePairing(peerId) }
            }
        }
        return r
    }

    /**
     * Re-fetch while "Waiting for $X": re-send the SAME stored bytes; after a rename build a
     * fresh approve. Errors are silent. Returns the outcome for the timeout rule.
     */
    fun refetch(peerId: String): com.pusharmor.protocol.PairDecide.Resend {
        val peer = store.peer(peerId) ?: return com.pusharmor.protocol.PairDecide.Resend.OK_OTHER
        val stored = peer.storedApprove
        val r = if (stored == null || peer.storedApproveName != store.ownName()) {
            ClockSkew.run({ buildApprove(peerId) }) { api.approve(peerId, it) }
        } else {
            api.approve(peerId, stored.toByteArray(Charsets.UTF_8))
        }
        if (r is ApiResult.Ok) applyApproveResult(peerId, r)
        return when {
            r is ApiResult.Ok -> if (store.peer(peerId)?.approveVerified == true) com.pusharmor.protocol.PairDecide.Resend.OK_C_VERIFIED
            else com.pusharmor.protocol.PairDecide.Resend.OK_OTHER
            r.isLoggedOut -> com.pusharmor.protocol.PairDecide.Resend.LOGGED_OUT
            r is ApiResult.Http && r.status == 429 -> com.pusharmor.protocol.PairDecide.Resend.RATE_LIMITED
            r is ApiResult.Http && r.status >= 500 -> com.pusharmor.protocol.PairDecide.Resend.SERVER_ERROR
            r is ApiResult.Http -> com.pusharmor.protocol.PairDecide.Resend.OK_OTHER
            else -> com.pusharmor.protocol.PairDecide.Resend.OFFLINE
        }
    }

    /** A returned "c": verified exactly like a received approve, but silent (no notice, no event). */
    fun verifyReturned(peerId: String, c: String) {
        val opened = InnerMessage.open(c, me.keys, me.id, me.account) { id ->
            store.peer(id)?.takeIf { it.pinned && it.id == peerId }?.let { PinnedKeys(B64url.decode(it.signPub!!), B64url.decode(it.encPub!!), it.pairingId!!) }
        }
        if (opened !is OpenResult.Ok || opened.fromId != peerId || opened.body !is MessageBody.Approve) return
        store.tx {
            val peer = store.peer(peerId) ?: return@tx
            val window = store.window(peerId) ?: return@tx
            val d = Receive.decide(opened, peer, window, me.id) { null }
            if (d !is Inbound.Accepted) return@tx // seen n: silent no-op
            val e = d.effect as? Effect.Approve ?: return@tx
            store.putWindow(peerId, d.pairingId, d.window)
            markApproveVerified(store, peer, e)
        }
    }

    /** Deny tap (pinned row): a deny message; for an unpinned row see RETURN LIST (zero pairing id). */
    fun deny(peerId: String): ApiResult<ApproveReply> {
        val peer = store.peer(peerId) ?: return ApiResult.Http(400, "bad request")
        val r = ClockSkew.run({ denyMessage(peer) }) { api.deny(peerId, it) }
        if (r is ApiResult.Ok || (r is ApiResult.Http && r.status == 400)) {
            store.tx {
                store.peer(peerId)?.let { store.putPeer(it.copy(deniedByMe = true, approved = false, lastApproveResult = (r as? ApiResult.Ok)?.value?.result)) }
                store.pairing(peerId)?.let { it.r.fill(0); store.deletePairing(peerId) }
            }
        }
        return r
    }

    private fun denyMessage(peer: Peer): String {
        if (peer.pinned) return outbox.simple(peer, MessageBody.Deny).message
        // Unpinned row: no pairing id exists; the Worker relays a deny only when X's allow has
        // me, which needs a pairing. Sealed to the listed key with a zero pairing id.
        val enc = B64url.decode(peer.listEncPub ?: error("no key"))
        return InnerMessage.build(me.keys, me.idRaw, peer.id, enc, ByteArray(8), 1, MessageBody.Deny)
    }

    companion object {
        /** X's approve verified: "approves me", name (highest n wins); the entry ends once I approved too. */
        fun markApproveVerified(store: LocalStore, peer: Peer, e: Effect.Approve) {
            var p = peer.copy(approveVerified = true, listAfterVerify = false, missing = false)
            if (e.storeName && e.name != null) p = p.copy(name = e.name, nameN = e.nameN)
            store.putPeer(p)
            if (p.approved) store.pairing(p.id)?.let { it.r.fill(0); store.deletePairing(p.id) }
        }
    }
}

/** Applies a received push (section 4 receive pipeline) and asks for its notices. */
class ReceiveEngine(
    private val store: LocalStore,
    private val me: Identity,
    private val effects: Effects,
) {
    /** Lookup, decide and apply run in ONE transaction (I288); notices run after it commits. */
    fun onMessage(wire: String, now: Long): Inbound {
        var after: (() -> Unit)? = null
        val inbound = store.tx {
            val inbound = ReceivePipeline.run(wire, me.keys, me.id, me.account, store::peer, store::window, store::historyIdFor)
            when (inbound) {
                is Inbound.Unreadable -> {
                    store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = inbound.peerId, type = "unreadable", at = now, read = true))
                    after = { if (inbound.fetch) effects.fetchPeersSoon(); effects.couldNotRead() }
                }
                is Inbound.Invalid -> {
                    store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = inbound.peerId, type = "invalid", at = now, read = true))
                    after = { effects.invalidMessage() }
                }
                is Inbound.RePresent -> after = { effects.rePresent(inbound.historyId) }
                is Inbound.Duplicate -> after = { rePresentControl(inbound.peerId, inbound.body) }
                is Inbound.Accepted -> after = apply(inbound, now)
            }
            inbound
        }
        after?.invoke()
        return inbound
    }

    private fun rePresentControl(peerId: String, body: MessageBody) {
        val peer = store.peer(peerId)
        when (body) {
            is MessageBody.Approve -> effects.approvedNotice(peerId, peer?.name)
            is MessageBody.Rename -> effects.renamedNotice(peer?.name, peer?.name ?: "")
            is MessageBody.Remove, MessageBody.Delete -> effects.peerListChanged()
            MessageBody.Logout -> effects.logoutNotice(peerId, true)
            MessageBody.Login -> effects.logoutNotice(peerId, false)
            MessageBody.Deny -> effects.deniedNotice(peerId)
            else -> Unit
        }
    }

    /** Runs inside the caller's transaction; returns the notices to post after it commits. */
    private fun apply(a: Inbound.Accepted, now: Long): (() -> Unit)? {
        var after: (() -> Unit)? = null
        run {
            store.putWindow(a.peerId, a.pairingId, a.window)
            val peer0 = store.peer(a.peerId) ?: return@run
            val peer = if (peer0.missing) peer0.copy(missing = false) else peer0
            if (peer !== peer0) store.putPeer(peer)
            when (val e = a.effect) {
                is Effect.Show -> {
                    val hid = store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = a.peerId, type = e.content.type.key, content = e.content.value, n = a.n, pairingId = a.pairingId, at = now))
                    after = { effects.showContent(hid, a.peerId, e.content) }
                }
                is Effect.Drop -> {
                    store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = a.peerId, type = "unreadable", at = now, read = true))
                    after = { effects.couldNotRead() }
                }
                is Effect.Approve -> {
                    ApproveFlow.markApproveVerified(store, peer, e)
                    after = { if (e.notify) effects.approvedNotice(a.peerId, store.peer(a.peerId)?.name) else effects.peerListChanged() }
                }
                is Effect.Rename -> {
                    if (e.applied) {
                        store.putPeer(peer.copy(name = e.newName, nameN = e.nameN))
                        after = { effects.peerChannelRename(a.peerId); effects.renamedNotice(e.oldName, e.newName) }
                    } else after = { effects.peerListChanged() }
                }
                is Effect.Remove -> {
                    store.peer(e.targetId)?.let { t ->
                        store.putPeer(t.copy(signPub = null, encPub = null, pairingId = null, removed = true, approved = false, approveVerified = false))
                        store.deleteWindow(t.id)
                        store.pairing(t.id)?.let { it.r.fill(0); store.deletePairing(t.id) }
                    }
                    after = { effects.peerChannelDelete(e.targetId); effects.peerListChanged() }
                }
                is Effect.SelfRemoved -> after = { effects.selfRemoved(e.deleted) }
                is Effect.Logout -> {
                    if (e.applied) {
                        store.putPeer(peer.copy(loggedOut = e.loggedOut, logoutN = a.n))
                        store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = a.peerId, type = if (e.loggedOut) "logged_out" else "logged_in", at = now, read = true))
                    }
                    after = { effects.logoutNotice(a.peerId, e.loggedOut) }
                }
                Effect.Deny -> {
                    store.putPeer(peer.copy(declined = true))
                    store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = a.peerId, type = "denied", at = now, read = true))
                    after = { effects.deniedNotice(a.peerId) }
                }
            }
        }
        return after
    }
}

/** Merge of GET /peers into the local rows (catalog Removal rules, Approvals). */
class PeersSync(private val store: LocalStore, private val me: Identity) {
    fun merge(reply: PeersReply) {
        store.tx {
            store.replaceAllowSet(reply.myAllow)
            val listed = reply.peers.filter { it.id != me.id && PeerList.entryValid(it.id, it.signPub, it.encPub, me.account) }
            val ids = listed.map { it.id }.toSet()
            for (l in listed) {
                val old = store.peer(l.id)
                var p = (old ?: Peer(id = l.id)).copy(
                    platform = l.platform, created = l.created, listSignPub = l.signPub, listEncPub = l.encPub,
                    loggedOut = l.loggedOut, listening = l.listening, reachable = l.reachable, listApprovesMe = l.approvesMe, listDeniesMe = l.deniesMe,
                    listAfterVerify = old?.approveVerified == true, missing = false,
                )
                if (p.removed && !p.pinned) p = p.copy(removed = false) // listed again: an unruled row
                // a pin whose keys differ from the list stays (pins never come from the list)
                val entry = l.nameForMe
                if (entry != null && p.pinned) {
                    val clear = NameEntry.open(entry, me.keys, me.id)
                    val name = clear?.let { NameEntry.verify(it, B64url.decode(p.signPub!!), p.id, me.id, p.pairingId!!) }
                    if (clear != null && name != null && clear.n > p.nameN) p = p.copy(name = name, nameN = clear.n)
                }
                store.putPeer(p)
            }
            for (p in store.peers()) {
                if (p.id in ids || p.id == me.id || p.removed) continue
                if (p.approved && p.pinned) store.putPeer(p.copy(missing = true))
                else if (store.pairing(p.id) == null) store.deletePeer(p.id)
            }
        }
    }
}

/** Log out (logout) and log in again (login): m for every pinned id of the allow set. */
class LogoutFlow(private val store: LocalStore, me: Identity, private val api: Api, private val reconcile: AllowReconcile) {
    private val outbox = Outbox(store, me)

    private fun messages(body: MessageBody): Map<String, String> =
        store.allowSet().mapNotNull { id -> store.peer(id)?.takeIf { it.pinned } }.associate { it.id to outbox.simple(it, body).message }

    fun logout(): ApiResult<Map<String, String>> =
        reconcile.withMissingRetry { ClockSkew.run({ messages(MessageBody.Logout) }) { api.logout(it) } }

    fun login(ticket: String): ApiResult<Map<String, String>> =
        reconcile.withMissingRetry { ClockSkew.run({ messages(MessageBody.Login) }) { api.login(ticket, it) } }
}
