package com.pusharmor.protocol.engine

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.protocol.CommitInput
import com.pusharmor.protocol.Countdown
import com.pusharmor.protocol.EntryChange
import com.pusharmor.protocol.Listed
import com.pusharmor.protocol.PairAction
import com.pusharmor.protocol.PairDecide
import com.pusharmor.protocol.PairEntryView
import com.pusharmor.protocol.PairKind
import com.pusharmor.protocol.PairMessage
import com.pusharmor.protocol.PairNotice
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.PeerList
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.matchesCommit

/**
 * Pairing state machine (catalog Pairing flow; Android design section 4). Pair sends never
 * happen inline: every send is persisted as the row's pending send and run by the
 * "pair-send-$peer" work ([sendPending]).
 */
class PairingEngine(
    private val store: LocalStore,
    private val me: Identity,
    private val api: Api,
    private val effects: Effects,
    private val random: (Int) -> ByteArray,
) {
    companion object {
        const val PAIRING_FAILED = "Pairing failed. Start again on the new peer."
        const val TIMED_OUT = "Pairing timed out. Tap Pair to start again."
        const val SEND_AGAIN_MS = 60_000L
    }

    private fun pk(nId: String, xId: String) = Ids.pairingKey(B64url.decode(nId), B64url.decode(xId))

    private fun pkOf(row: PairingRow) = if (row.role == PairRole.N) pk(me.id, row.peerId) else pk(row.peerId, me.id)

    private fun listedEncPub(peer: Peer): ByteArray? {
        val sp = peer.listSignPub ?: return null
        val ep = peer.listEncPub ?: return null
        if (!PeerList.entryValid(peer.id, sp, ep, me.account)) return null
        return B64url.decode(ep)
    }

    /** [Pair] tap on N. Refuses a pinned row and a row with an open entry (I234). */
    fun tapPair(peerId: String, now: Long): Boolean {
        val ok = store.tx {
            val peer = store.peer(peerId) ?: return@tx false
            if (peer.pinned || store.pairing(peerId) != null) return@tx false
            val enc = listedEncPub(peer) ?: return@tx false
            val rN = random(32)
            val cN = Ids.commit(me.keys.signPub, me.keys.encPub, rN)
            val msg = PairMessage.seal(PairMessage.Commit(me.idRaw, cN), peerId, enc)
            store.putPairing(PairingRow(peerId, PairRole.N, PairState.COMMITTED, rN, cN, startedAt = now, pendingKind = PairKind.COMMIT, pendingMessage = msg))
            store.putPeer(peer.copy(note = null, deniedByMe = false))
            true
        }
        if (ok) effects.schedulePairSend(peerId, replace = true)
        return ok
    }

    /** A pair push (366 chars). [fetchListed] runs one GET /peers and says whether the id is listed now. */
    fun onPush(wire: String, now: Long, fetchListed: (String) -> Boolean) {
        val m = PairMessage.open(wire, me.keys, me.id, me.account)
        if (m == null) { effects.couldNotRead(); return }
        val from = B64url.encode(m.fromId)
        when (m) {
            is PairMessage.Commit -> onCommit(from, m.cN, now, fetchListed)
            is PairMessage.Keys -> if (m.kind == PairKind.REPLY) onReply(from, m, now) else onOpen(from, m, now)
        }
    }

    private fun commitInput(from: String, cN: ByteArray, now: Long, listed: Listed): CommitInput {
        val peer = store.peer(from)
        val row = store.pairing(from)
        return CommitInput(
            ownId = me.idRaw, fromId = B64url.decode(from), cN = cN,
            entry = row?.let { PairEntryView(it.role, it.state, it.cN, it.authorized) },
            pinned = peer?.pinned == true, approved = peer?.approved == true && peer.pinned,
            approveVerified = peer?.approveVerified == true,
            listApprovesMe = peer?.takeIf { it.listSignPub != null }?.listApprovesMe, listAfterVerify = peer?.listAfterVerify == true,
            listed = listed, openEntries = store.pairings().size,
            capTimestamps = store.capTimestamps(), now = now / 1000,
        )
    }

    fun onCommit(from: String, cN: ByteArray, now: Long, fetchListed: (String) -> Boolean) {
        val listedNow = store.peer(from)?.listEncPub != null
        var listed = if (listedNow) Listed.YES else Listed.NOT_FETCHED
        var decision: com.pusharmor.protocol.PairDecision
        while (true) {
            // The cap check, the open-entry count, the cap append and the entry persist are ONE transaction (I235).
            decision = store.tx {
                val d = PairDecide.commit(commitInput(from, cN, now, listed))
                applyCommit(from, cN, now, d)
                d
            }
            if (decision.action != PairAction.FETCH) break
            listed = if (fetchListed(from)) Listed.AFTER_FETCH else Listed.NO
        }
        val row = store.pairing(from)
        when (decision.notice) {
            PairNotice.COMMIT -> effects.pairNotice(from, pk(from, me.id), PairNoticeKind.COMMIT)
            PairNotice.REPRESENT -> row?.let { represent(it) }
            PairNotice.HALF_STATE -> effects.pairNotice(from, pk(from, me.id), PairNoticeKind.PAIR_AGAIN)
            PairNotice.CROSSING -> effects.pairNotice(from, pk(me.id, from), PairNoticeKind.IN_PROGRESS)
            PairNotice.COULD_NOT_READ -> effects.couldNotRead()
            PairNotice.NONE -> Unit
        }
        if (decision.action == PairAction.REPLY) effects.schedulePairSend(from, replace = false)
    }

    private fun applyCommit(from: String, cN: ByteArray, now: Long, d: com.pusharmor.protocol.PairDecision) {
        when (d.entry) {
            EntryChange.CREATED_REPLIED, EntryChange.N_WIPED_X_REPLIED -> {
                store.pairing(from)?.let { it.r.fill(0); store.deletePairing(from) }
                val enc = store.peer(from)?.let { listedEncPub(it) } ?: return
                val rX = random(32)
                // Row (c_N, r_X, state) persisted BEFORE the reply send (I216).
                store.putPairing(PairingRow(from, PairRole.X, PairState.REPLIED, rX, cN, startedAt = now, authorized = true,
                    pendingKind = PairKind.REPLY, pendingMessage = reply(from, enc, rX)))
                if (d.capCounted) store.addCapTimestamp(now / 1000)
            }
            EntryChange.CREATED_PROMPTED -> {
                store.putPairing(PairingRow(from, PairRole.X, PairState.PROMPTED, random(32), cN, startedAt = now, authorized = false))
            }
            EntryChange.ABORTED -> {
                store.pairing(from)?.let { it.r.fill(0); store.deletePairing(from) }
                dropPairingPin(from)
                store.peer(from)?.let { store.putPeer(it.copy(note = PAIRING_FAILED)) }
            }
            EntryChange.UNCHANGED, EntryChange.NONE -> {
                if (d.action == PairAction.REPLY) {
                    // 3a: re-send the SAME reply (same r_X); rebuilt only if it was already sent.
                    val row = store.pairing(from) ?: return
                    if (row.pendingMessage == null) {
                        val enc = store.peer(from)?.let { listedEncPub(it) } ?: return
                        store.putPairing(row.copy(pendingKind = PairKind.REPLY, pendingMessage = reply(from, enc, row.r)))
                    }
                }
            }
        }
    }

    private fun reply(to: String, enc: ByteArray, rX: ByteArray) =
        PairMessage.seal(PairMessage.Keys(PairKind.REPLY, me.idRaw, me.keys.signPub, me.keys.encPub, rX), to, enc)

    private fun represent(row: PairingRow) {
        val kind = if (row.state == PairState.SHOWN) PairNoticeKind.COMPARE else PairNoticeKind.COMMIT
        effects.pairNotice(row.peerId, pkOf(row), kind, row.fingerprint)
    }

    /** N on reply: only in committed; the keys hash to X's id (checked by the open). */
    fun onReply(from: String, m: PairMessage.Keys, now: Long) {
        val ok = store.tx {
            val row = store.pairing(from) ?: return@tx false
            if (row.role != PairRole.N || row.state != PairState.COMMITTED) return@tx false
            val fp = Ids.fingerprint(me.keys.signPub, me.keys.encPub, m.signPub, m.encPub, row.r, m.r)
            val pid = Ids.pairingId(row.r, m.r)
            pin(from, m.signPub, m.encPub, pid)
            val open = PairMessage.seal(PairMessage.Keys(PairKind.OPEN, me.idRaw, me.keys.signPub, me.keys.encPub, row.r), from, m.encPub)
            store.putPairing(row.copy(state = PairState.SHOWN, peerSignPub = m.signPub, peerEncPub = m.encPub, peerR = m.r,
                fingerprint = fp, pendingKind = PairKind.OPEN, pendingMessage = open, notBefore = 0))
            true
        }
        if (!ok) { effects.couldNotRead(); return }
        effects.peerChannelCreate(from)
        effects.pairNotice(from, pk(me.id, from), PairNoticeKind.READY)
        effects.schedulePairSend(from, replace = true)
    }

    /** X on open: only in replied; sha256("PA-SAS1C\n" || keys || r_N) must equal c_N. */
    fun onOpen(from: String, m: PairMessage.Keys, now: Long) {
        var result = 0 // 0 drop, 1 shown, 2 represent, 3 abort
        store.tx {
            val row = store.pairing(from) ?: return@tx
            if (row.role != PairRole.X) return@tx
            if (row.state == PairState.SHOWN) {
                if (m.signPub.contentEquals(row.peerSignPub) && m.encPub.contentEquals(row.peerEncPub) && m.r.contentEquals(row.peerR)) result = 2
                return@tx
            }
            if (row.state != PairState.REPLIED) return@tx
            if (row.cN == null || !m.matchesCommit(row.cN)) {
                row.r.fill(0); store.deletePairing(from)
                store.peer(from)?.let { store.putPeer(it.copy(note = PAIRING_FAILED)) }
                result = 3
                return@tx
            }
            val fp = Ids.fingerprint(m.signPub, m.encPub, me.keys.signPub, me.keys.encPub, m.r, row.r)
            val pid = Ids.pairingId(m.r, row.r)
            pin(from, m.signPub, m.encPub, pid)
            store.putPairing(row.copy(state = PairState.SHOWN, peerSignPub = m.signPub, peerEncPub = m.encPub, peerR = m.r, fingerprint = fp))
            result = 1
        }
        val row = store.pairing(from)
        when (result) {
            1 -> { effects.peerChannelCreate(from); effects.pairNotice(from, pk(from, me.id), PairNoticeKind.COMPARE, row?.fingerprint) }
            2 -> row?.let { represent(it) }
            else -> effects.couldNotRead()
        }
    }

    /** Pins exactly these keys, stores the pairing id, counter 0, fresh replay window. */
    private fun pin(peerId: String, signPub: ByteArray, encPub: ByteArray, pairingId: ByteArray) {
        val peer = store.peer(peerId) ?: Peer(id = peerId)
        store.putPeer(peer.copy(signPub = B64url.encode(signPub), encPub = B64url.encode(encPub), pairingId = pairingId,
            lastN = 0, approved = false, approveVerified = false, deniedByMe = false, declined = false, removed = false,
            missing = false, name = null, nameN = 0, pauseN = 0, storedApprove = null, storedApproveName = null, note = null))
        store.resetCounter(peerId)
        store.putWindow(peerId, pairingId, ReplayWindow.fresh())
    }

    /** Drops the pin made by a pairing (Cancel pairing, timeout, abort). */
    private fun dropPairingPin(peerId: String) {
        val peer = store.peer(peerId) ?: return
        store.putPeer(peer.copy(signPub = null, encPub = null, pairingId = null, lastN = 0, approved = false, approveVerified = false,
            storedApprove = null, storedApproveName = null, listAfterVerify = false))
        store.resetCounter(peerId)
        store.deleteWindow(peerId)
    }

    /** [Reply] tap on a prompted X row: authorized, sent with REPLACE (I236). */
    fun tapReply(peerId: String): Boolean {
        val ok = store.tx {
            val row = store.pairing(peerId) ?: return@tx false
            if (row.role != PairRole.X || row.state != PairState.PROMPTED) return@tx false
            val enc = store.peer(peerId)?.let { listedEncPub(it) } ?: return@tx false
            store.putPairing(row.copy(authorized = true, pendingKind = PairKind.REPLY, pendingMessage = row.pendingMessage ?: reply(peerId, enc, row.r)))
            true
        }
        if (ok) effects.schedulePairSend(peerId, replace = true)
        return ok
    }

    /** [Send again] on N: same commit (same c_N) in committed, same open in shown; 60 s after the last send. */
    fun sendAgain(peerId: String, now: Long): Boolean {
        val ok = store.tx {
            val row = store.pairing(peerId) ?: return@tx false
            if (row.role != PairRole.N || now - row.lastSendAt < SEND_AGAIN_MS) return@tx false
            val msg = when (row.state) {
                PairState.COMMITTED -> {
                    val enc = store.peer(peerId)?.let { listedEncPub(it) } ?: return@tx false
                    PairMessage.seal(PairMessage.Commit(me.idRaw, row.cN!!), peerId, enc)
                }
                PairState.SHOWN -> PairMessage.seal(PairMessage.Keys(PairKind.OPEN, me.idRaw, me.keys.signPub, me.keys.encPub, row.r), peerId, row.peerEncPub!!)
                else -> return@tx false
            }
            store.putPairing(row.copy(pendingKind = if (row.state == PairState.COMMITTED) PairKind.COMMIT else PairKind.OPEN, pendingMessage = msg))
            true
        }
        if (ok) effects.schedulePairSend(peerId, replace = true)
        return ok
    }

    fun canSendAgain(row: PairingRow, now: Long) = row.role == PairRole.N && now - row.lastSendAt >= SEND_AGAIN_MS

    enum class SendStep { DONE, RETRY, WAIT_UNTIL, STOP }

    /**
     * The "pair-send-$peer" work: POST /pair/$peer with the pending message. Returns what the
     * worker should do next; [WAIT_UNTIL] uses the row's notBefore.
     */
    fun sendPending(peerId: String, now: Long): SendStep {
        val row = store.pairing(peerId) ?: return SendStep.DONE
        if (Countdown.expired(row.startedAt, now)) return SendStep.STOP
        val msg = row.pendingMessage ?: return SendStep.DONE
        val kind = row.pendingKind ?: return SendStep.DONE
        if (now < row.notBefore) return SendStep.WAIT_UNTIL
        val r = api.pair(peerId, kind.wire, msg)
        return store.tx {
            val cur = store.pairing(peerId) ?: return@tx SendStep.DONE
            when (r) {
                is ApiResult.Ok -> {
                    val sent = cur.pendingMessage == msg
                    var next = cur.copy(lastSendAt = now, lastResult = r.value)
                    if (sent) next = next.copy(pendingKind = null, pendingMessage = null)
                    if (r.value == "sent" && next.role == PairRole.X && next.state == PairState.PROMPTED && next.authorized) next = next.copy(state = PairState.REPLIED)
                    store.putPairing(next)
                    SendStep.DONE
                }
                is ApiResult.Http -> when {
                    r.status == 429 -> {
                        store.putPairing(cur.copy(notBefore = now + (r.retryAfter ?: 60) * 1000, lastSendAt = now))
                        SendStep.WAIT_UNTIL
                    }
                    r.status >= 500 -> SendStep.RETRY
                    else -> { // permanent (401 paused included): stays prompted with [Reply] / [Send again]
                        store.putPairing(promptOnFailure(cur).copy(lastSendAt = now, lastResult = r.error))
                        SendStep.STOP
                    }
                }
                ApiResult.Network -> SendStep.RETRY
            }
        }
    }

    /** Work exhausted: X with an authorized reply shows [Reply] again (state prompted). */
    fun promptOnFailure(row: PairingRow): PairingRow =
        if (row.role == PairRole.X && row.state == PairState.REPLIED && row.pendingMessage != null) row.copy(state = PairState.PROMPTED) else row

    fun onSendExhausted(peerId: String) = store.tx { store.pairing(peerId)?.let { store.putPairing(promptOnFailure(it)) } }

    /** Cancel pairing (I264, I279): local only, then the allow reconcile. */
    fun cancelPairing(peerId: String) {
        store.tx {
            store.pairing(peerId)?.let { it.r.fill(0); store.deletePairing(peerId) }
            dropPairingPin(peerId)
            store.peer(peerId)?.let { store.putPeer(it.copy(note = null)) }
        }
        effects.peerChannelDelete(peerId)
        effects.reconcileSoon()
    }

    /**
     * Timeout check (14 days). [refetch] runs the approve re-send for a "Waiting for $X" row
     * and reports its outcome. Returns the decision taken.
     */
    fun checkTimeout(peerId: String, now: Long, refetch: (String) -> PairDecide.Resend): PairDecide.Timeout? {
        val row = store.pairing(peerId) ?: return null
        if (!Countdown.expired(row.startedAt, now)) return null
        val peer = store.peer(peerId)
        val approved = peer?.approved == true && peer.pinned
        var t = PairDecide.timeout(peer?.approveVerified == true, approved, null)
        if (t == PairDecide.Timeout.RESEND) {
            t = PairDecide.timeout(false, approved, refetch(peerId))
        }
        when (t) {
            PairDecide.Timeout.DROP_PIN -> {
                store.tx {
                    store.pairing(peerId)?.let { it.r.fill(0); store.deletePairing(peerId) }
                    dropPairingPin(peerId)
                    store.peer(peerId)?.let { store.putPeer(it.copy(note = TIMED_OUT)) }
                }
                effects.peerChannelDelete(peerId)
                effects.reconcileSoon()
            }
            PairDecide.Timeout.KEEP_PIN, PairDecide.Timeout.COMPLETE ->
                store.tx { store.pairing(peerId)?.let { it.r.fill(0); store.deletePairing(peerId) } }
            else -> Unit
        }
        return t
    }

    /** N row text: hint after 3 days in committed (golden pair_hint). */
    fun hint(row: PairingRow, now: Long): PairDecide.Hint? {
        if (row.role != PairRole.N || row.state != PairState.COMMITTED) return null
        val peer = store.peer(row.peerId)
        return PairDecide.hint(peer?.takeIf { it.listSignPub != null }?.listApprovesMe, (now - row.startedAt) / 1000)
    }
}
