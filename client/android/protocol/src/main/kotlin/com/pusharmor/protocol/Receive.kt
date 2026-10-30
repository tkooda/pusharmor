package com.pusharmor.protocol

import com.pusharmor.crypto.B64url

/** What the user sees for a url / text / tel item (catalog Receiver acceptance). */
data class ShownContent(
    val type: ContentType,
    val value: String,
    /** Parsed href and host for a url that passed the strict parse; null otherwise. */
    val href: String? = null,
    val host: String? = null,
) {
    /** url that failed the strict parse, or tel that failed phone detection: shown as text. */
    val showAsText: Boolean get() = (type == ContentType.URL && href == null) || (type == ContentType.TEL && !Phone.isPhone(value))
    val canDial: Boolean get() = type == ContentType.TEL && Phone.isPhone(value)
}

/** Effect of an accepted (window-fresh, signature-verified) message. */
sealed class Effect {
    data class Show(val content: ShownContent) : Effect()

    /** Dropped by the acceptance table after the verify (History may name the peer). */
    data class Drop(val why: String) : Effect()

    /** Verified approve. [notify]: "$name approved this device" (only when I approved X). */
    data class Approve(val name: String?, val nameN: Long, val storeName: Boolean, val notify: Boolean) : Effect()

    data class Rename(val oldName: String?, val newName: String, val nameN: Long, val applied: Boolean) : Effect()

    data class Remove(val targetId: String) : Effect()

    /** remove naming me (deleted = false) or delete (deleted = true): the self-removed path. */
    data class SelfRemoved(val deleted: Boolean) : Effect()

    data class Logout(val loggedOut: Boolean, val applied: Boolean) : Effect()

    object Deny : Effect()
}

sealed class Inbound {
    /** "could not read": notice on FCM, History event; [peerId] only when the signature verified. */
    data class Unreadable(val peerId: String?, val fetch: Boolean = false) : Inbound()

    /** Replay: "Invalid message received" notice on FCM and History event. */
    data class Invalid(val peerId: String) : Inbound()

    /** Seen n with a History row: re-present that row's notification, nothing else. */
    data class RePresent(val historyId: Long) : Inbound()

    /** Seen n of a control type: no state change, no event; on FCM re-present that type's notice. */
    data class Duplicate(val peerId: String, val body: MessageBody) : Inbound()

    /** Window-fresh: commit [window] in the same transaction as any History row. */
    data class Accepted(val peerId: String, val n: Long, val pairingId: ByteArray, val window: ReplayWindow, val body: MessageBody, val effect: Effect) : Inbound()
}

object Receive {
    /**
     * Replay window and acceptance table for a message that opened and verified.
     * [historyIdFor] finds a History row for (sender, pairing id, n).
     */
    fun decide(
        ok: OpenResult.Ok,
        peer: Peer,
        window: ReplayWindow,
        ownId: String,
        historyIdFor: (Long) -> Long?,
    ): Inbound {
        when (window.check(ok.n)) {
            ReplayWindow.Verdict.TOO_OLD -> return Inbound.Invalid(peer.id)
            ReplayWindow.Verdict.SEEN -> {
                if (ok.body.isControl) return Inbound.Duplicate(peer.id, ok.body)
                val hid = historyIdFor(ok.n)
                return if (hid != null) Inbound.RePresent(hid) else Inbound.Invalid(peer.id)
            }
            ReplayWindow.Verdict.FRESH -> Unit
        }
        // a dropped message leaves the replay window unchanged, so a later re-delivery still counts as fresh
        val effect = accept(ok, peer, ownId)
        val next = if (effect is Effect.Drop) window else window.accept(ok.n)
        return Inbound.Accepted(peer.id, ok.n, ok.pairingId, next, ok.body, effect)
    }

    fun accept(ok: OpenResult.Ok, peer: Peer, ownId: String): Effect {
        val approved = peer.approved && !peer.deniedByMe
        return when (val b = ok.body) {
            is MessageBody.Url, is MessageBody.Text, is MessageBody.Tel -> {
                if (!approved) return Effect.Drop("not approved")
                val (type, value) = when (b) {
                    is MessageBody.Url -> ContentType.URL to b.value
                    is MessageBody.Text -> ContentType.TEXT to b.value
                    is MessageBody.Tel -> ContentType.TEL to b.value
                    else -> error("unreachable")
                }
                if (SizeCap.utf8Size(value) > SizeCap.MAX_CONTENT_BYTES) return Effect.Drop("too large")
                val shownValue = if (type == ContentType.TEL) Phone.normalize(value).takeIf { Phone.isPhone(value) } ?: value else value
                val parsed = if (type == ContentType.URL) UrlCheck.parse(value) else null
                Effect.Show(ShownContent(type, shownValue, parsed?.href, parsed?.host))
            }
            is MessageBody.Approve -> {
                if (peer.deniedByMe) return Effect.Drop("denied by me")
                val e = b.entry
                if (e.n != ok.n) return Effect.Drop("name n")
                val name = verifyName(e, peer, ownId) ?: return Effect.Drop("name signature")
                val newer = e.n > peer.nameN
                Effect.Approve(name, e.n, newer, notify = peer.approved)
            }
            is MessageBody.Rename -> {
                if (!approved) return Effect.Drop("not approved")
                val e = b.entry
                if (e.n != ok.n) return Effect.Drop("name n")
                val name = verifyName(e, peer, ownId) ?: return Effect.Drop("name signature")
                Effect.Rename(peer.name, name, e.n, applied = e.n > peer.nameN)
            }
            is MessageBody.Remove -> {
                if (!approved) return Effect.Drop("not approved")
                if (b.peerId == ownId) Effect.SelfRemoved(false) else Effect.Remove(b.peerId)
            }
            MessageBody.Delete -> if (!approved) Effect.Drop("not approved") else Effect.SelfRemoved(true)
            MessageBody.Logout, MessageBody.Login -> {
                if (!approved) return Effect.Drop("not approved")
                Effect.Logout(b == MessageBody.Logout, applied = ok.n > peer.logoutN)
            }
            MessageBody.Deny -> if (!approved) Effect.Drop("not approved") else Effect.Deny
        }
    }

    /** approve / rename: entry n equals the message n and the entry verifies (checked before the replay window). */
    fun nameEntryOk(ok: OpenResult.Ok, peer: Peer, ownId: String): Boolean {
        val e = when (val b = ok.body) {
            is MessageBody.Approve -> b.entry
            is MessageBody.Rename -> b.entry
            else -> return true
        }
        return e.n == ok.n && verifyName(e, peer, ownId) != null
    }

    private fun verifyName(e: NameEntryClear, peer: Peer, ownId: String): String? {
        val sp = peer.signPub?.let { B64url.decodeOrNull(it) } ?: return null
        val pid = peer.pairingId ?: return null
        return NameEntry.verify(e, sp, peer.id, ownId, pid)
    }
}

/** Receive pipeline (section 4 steps 1-7) over a stored peer view. */
object ReceivePipeline {
    /**
     * [peerOf] returns the local peer row for an id (pinned or not); [windowOf] its replay
     * state; [historyIdFor] a History row id for (sender, pairing id, n).
     */
    fun run(
        wire: String,
        own: com.pusharmor.crypto.KeyOps,
        ownId: String,
        ownAccount: ByteArray,
        peerOf: (String) -> Peer?,
        windowOf: (String) -> ReplayWindow?,
        historyIdFor: (String, ByteArray, Long) -> Long?,
    ): Inbound {
        val opened = InnerMessage.open(wire, own, ownId, ownAccount) { id ->
            val p = peerOf(id)
            if (p == null || !p.pinned || p.removed) null
            else PinnedKeys(B64url.decode(p.signPub!!), B64url.decode(p.encPub!!), p.pairingId!!)
        }
        return when (opened) {
            is OpenResult.Fail -> Inbound.Unreadable(opened.verifiedFrom)
            is OpenResult.UnknownSender -> Inbound.Unreadable(null, fetch = peerOf(opened.fromId)?.removed != true)
            is OpenResult.Ok -> {
                val peer = peerOf(opened.fromId)!!
                if (!Receive.nameEntryOk(opened, peer, ownId)) return Inbound.Unreadable(peer.id)
                val window = windowOf(peer.id) ?: return Inbound.Unreadable(null)
                Receive.decide(opened, peer, window, ownId) { n -> historyIdFor(peer.id, opened.pairingId, n) }
            }
        }
    }
}

/** GET /peers list entry check: own account prefix, keyhash, valid distinct 65-byte points. */
object PeerList {
    fun entryValid(id: String, signPub: String, encPub: String, ownAccount: ByteArray): Boolean {
        val raw = com.pusharmor.crypto.Ids.decodeId(id) ?: return false
        val sp = B64url.decodeExact(signPub, 65) ?: return false
        val ep = B64url.decodeExact(encPub, 65) ?: return false
        return com.pusharmor.crypto.Ids.idMatchesKeys(raw, ownAccount, sp, ep)
    }
}
