package com.pusharmor.store

import com.pusharmor.protocol.JValue
import com.pusharmor.protocol.PairKind
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.ReplayWindow
import com.pusharmor.protocol.StrictJson
import com.pusharmor.protocol.engine.Direction
import com.pusharmor.protocol.engine.HistoryRow
import com.pusharmor.protocol.engine.LocalStore
import com.pusharmor.protocol.engine.PairingRow

/** LocalStore over Room (app-private, credential-encrypted storage). */
class RoomLocalStore(val db: PaDatabase) : LocalStore {
    val dao = db.dao()

    override fun <T> tx(block: () -> T): T = db.runInTransaction<T> { block() }

    override fun peer(id: String) = dao.peer(id)?.toPeer()
    override fun peers() = dao.peers().map { it.toPeer() }
    override fun putPeer(p: Peer) = tx {
        val old = dao.peer(p.id)
        dao.putPeer(p.toEntity(old))
    }
    override fun deletePeer(id: String) = dao.deletePeer(id)
    override fun resetCounter(peerId: String) = dao.resetCounter(peerId)

    override fun reserveCounter(peerId: String): Long = tx {
        check(dao.bumpCounter(peerId) == 1) { "no peer row" }
        dao.counter(peerId)
    }

    override fun window(peerId: String) = dao.replay(peerId)?.let { ReplayWindow.of(it.h, it.bitmap) }
    override fun putWindow(peerId: String, pairingId: ByteArray, w: ReplayWindow) = dao.putReplay(ReplayEntity(peerId, pairingId, w.h, w.bitmapBytes()))
    override fun deleteWindow(peerId: String) = dao.deleteReplay(peerId)

    override fun pairing(peerId: String) = dao.pairing(peerId)?.toRow()
    override fun pairings() = dao.pairings().map { it.toRow() }
    override fun putPairing(r: PairingRow) = dao.putPairing(r.toEntity())
    override fun deletePairing(peerId: String) = tx {
        dao.pairing(peerId)?.let { dao.putPairing(it.copy(r = ByteArray(32))) } // zero r first
        dao.deletePairing(peerId)
    }

    override fun capTimestamps() = dao.cap()
    override fun addCapTimestamp(t: Long) = tx {
        dao.pruneCap(t - 2 * 86_400)
        dao.addCap(CapEntity(at = t))
    }

    override fun allowSet() = dao.allow().toSet()
    override fun replaceAllowSet(ids: Collection<String>) = tx { dao.clearAllow(); ids.forEach { dao.addAllow(AllowEntity(it)) } }
    override fun addAllow(id: String) = dao.addAllow(AllowEntity(id))
    override fun removeAllow(id: String) = dao.removeAllow(id)

    override fun historyIdFor(peerId: String, pairingId: ByteArray, n: Long) = dao.historyId(peerId, pairingId, n)

    /** Consecutive could-not-read (or invalid) events merge into the newest row with a count. */
    override fun insertHistory(row: HistoryRow): Long = tx {
        if (row.type == "unreadable" || row.type == "invalid") {
            val newest = dao.newestHistory()
            if (newest != null && newest.type == row.type && newest.peerId == row.peerId) {
                dao.bumpEvent(newest.id, row.at)
                return@tx newest.id
            }
        }
        dao.insertHistory(row.toEntity())
    }

    override fun ownName() = dao.self()?.name ?: ""

    /** Self-removed / account-deleted wipe of protocol state (history is kept, I267). */
    fun wipeRegistration() = tx {
        dao.zeroAllR()
        dao.deleteAllPairings()
        dao.deleteAllCap()
        dao.deleteAllReplay()
        dao.clearAllow()
        dao.deleteAllPeers()
        dao.deleteSelf()
    }
}

private fun resultsJson(m: Map<String, String>) = m.entries.joinToString(",", "{", "}") { "${StrictJson.quote(it.key)}:${StrictJson.quote(it.value)}" }

private fun resultsOf(s: String): Map<String, String> =
    (StrictJson.parseOrNull(s) as? JValue.JObject)?.fields?.mapNotNull { (k, v) -> (v as? JValue.JString)?.let { k to it.value } }?.toMap() ?: emptyMap()

fun HistoryRow.toEntity() = HistoryEntity(id, direction.name, peerId, type, content, n, pairingId, at, read, resultsJson(results), count)
fun HistoryEntity.toRow() = HistoryRow(id, Direction.valueOf(direction), peerId, type, content, n, pairingId, at, read, resultsOf(results), count)

fun PeerEntity.toPeer() = Peer(
    id = id, platform = platform, created = created, listSignPub = listSignPub, listEncPub = listEncPub, signPub = signPub, encPub = encPub,
    pairingId = pairingId, approved = approved, deniedByMe = deniedByMe, approveVerified = approveVerified, listApprovesMe = listApprovesMe,
    listDeniesMe = listDeniesMe, listAfterVerify = listAfterVerify, declined = declined, reachable = reachable, loggedOut = loggedOut, logoutN = logoutN,
    hidden = hidden, name = name, nameN = nameN, removed = removed, missing = missing, lastN = lastN, channelId = channelId,
    storedApprove = storedApprove, storedApproveName = storedApproveName, lastApproveResult = lastApproveResult, lastSendAt = lastSendAt, note = note,
    pairAgain = pairAgain,
)

/** Keeps the per-peer switches of [old] (they are not part of the protocol view). */
fun Peer.toEntity(old: PeerEntity?) = PeerEntity(
    id, platform, created, listSignPub, listEncPub, signPub, encPub, pairingId, approved, deniedByMe, approveVerified, listApprovesMe,
    listDeniesMe, listAfterVerify, declined, reachable, loggedOut, logoutN, hidden, name, nameN, removed, missing, old?.lastN ?: lastN,
    channelId ?: old?.channelId, storedApprove, storedApproveName, lastApproveResult, lastSendAt, note, pairAgain,
    lockScreen = old?.lockScreen ?: true, watch = old?.watch ?: true, hideContent = old?.hideContent ?: false,
)

fun PairingEntity.toRow() = PairingRow(
    peerId, PairRole.valueOf(role), PairState.valueOf(state), r, cN, peerSignPub, peerEncPub, peerR, startedAt,
    pendingKind?.let { PairKind.valueOf(it) }, pendingMessage, notBefore, authorized, fingerprint, lastSendAt, lastResult,
)

fun PairingRow.toEntity() = PairingEntity(
    peerId, role.name, state.name, r, cN, peerSignPub, peerEncPub, peerR, startedAt, pendingKind?.name, pendingMessage, notBefore,
    authorized, fingerprint, lastSendAt, lastResult,
)
