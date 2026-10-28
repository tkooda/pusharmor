package com.pusharmor.protocol.engine

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.KeyOps
import com.pusharmor.protocol.PairKind
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.ReplayWindow

/** This device: keys, own id and account prefix. */
class Identity(val keys: KeyOps, val id: String) {
    val idRaw: ByteArray = B64url.decode(id)
    val account: ByteArray = idRaw.copyOf(9)
}

/** One pairing entry (Room table "pairing"). Times in ms. */
data class PairingRow(
    val peerId: String,
    val role: PairRole,
    val state: PairState,
    /** Own r (r_N on N, r_X on X); zeroed and dropped when the entry ends. */
    val r: ByteArray,
    /** N: own c_N; X: the received c_N. */
    val cN: ByteArray?,
    /** Keys this pairing pinned (after reply on N, after open on X). */
    val peerSignPub: ByteArray? = null,
    val peerEncPub: ByteArray? = null,
    /** r of the other side, kept until the entry ends (for an identical open). */
    val peerR: ByteArray? = null,
    val startedAt: Long,
    val pendingKind: PairKind? = null,
    val pendingMessage: String? = null,
    /** Earliest time for the pending send (429 retry_after floor). */
    val notBefore: Long = 0,
    /** X: the reply is authorized (counted automatic reply or a [Reply] tap); never cleared. */
    val authorized: Boolean = false,
    val fingerprint: String? = null,
    val lastSendAt: Long = 0,
    val lastResult: String? = null,
)

enum class Direction { SENT, RECEIVED }

/** History row: a message (url / text / tel) or an event. */
data class HistoryRow(
    val id: Long = 0,
    val direction: Direction,
    val peerId: String?,
    /** "url" | "text" | "tel" for messages; "denied" | "paused" | "resumed" | "unreadable" | "invalid" for events. */
    val type: String,
    val content: String? = null,
    val n: Long? = null,
    val pairingId: ByteArray? = null,
    val at: Long,
    val read: Boolean = false,
    /** Sent items: per-peer results. */
    val results: Map<String, String> = emptyMap(),
    /** Merged event count. */
    val count: Int = 1,
) {
    val isEvent: Boolean get() = type !in setOf("url", "text", "tel")
}

/** Storage the engines need (Room in the app, in memory in tests). */
interface LocalStore {
    /** Runs [block] in one transaction (atomic for every process of the app). */
    fun <T> tx(block: () -> T): T

    fun peer(id: String): Peer?
    fun peers(): List<Peer>
    /** Writes [p] but never changes last_n of an existing row (use [resetCounter]). */
    fun putPeer(p: Peer)
    fun deletePeer(id: String)

    /** Reserves n = last_n + 1 for [peerId] and persists it in one committed atomic increment. */
    fun reserveCounter(peerId: String): Long

    /** Sets last_n to 0 (pin and unpin only). */
    fun resetCounter(peerId: String)

    fun window(peerId: String): ReplayWindow?
    fun putWindow(peerId: String, pairingId: ByteArray, w: ReplayWindow)
    fun deleteWindow(peerId: String)

    fun pairing(peerId: String): PairingRow?
    fun pairings(): List<PairingRow>
    fun putPairing(r: PairingRow)
    fun deletePairing(peerId: String)

    /** Automatic pair reply timestamps (unix s), rolling 24 h cap. */
    fun capTimestamps(): List<Long>
    fun addCapTimestamp(t: Long)

    fun allowSet(): Set<String>
    fun replaceAllowSet(ids: Collection<String>)
    fun addAllow(id: String)
    fun removeAllow(id: String)

    fun historyIdFor(peerId: String, pairingId: ByteArray, n: Long): Long?
    fun insertHistory(row: HistoryRow): Long

    /** Own peer name (1..32 printable ASCII). */
    fun ownName(): String
}

/** User-visible side effects the engines ask for. The app maps them to notifications, toasts and WorkManager. */
interface Effects {
    fun schedulePairSend(peerId: String, replace: Boolean) {}
    fun reconcileSoon() {}
    fun fetchPeersSoon() {}
    fun peerChannelCreate(peerId: String) {}
    fun peerChannelDelete(peerId: String) {}
    fun peerChannelRename(peerId: String) {}

    /** Pairing notices under the notification id from pk. */
    fun pairNotice(peerId: String, pk: String, kind: PairNoticeKind, fingerprint: String? = null) {}
    fun cancelPairNotice(pk: String) {}

    /** Generic "could not read" (FCM only, the app decides). */
    fun couldNotRead() {}
    fun invalidMessage() {}

    fun showContent(historyId: Long, peerId: String, content: com.pusharmor.protocol.ShownContent) {}
    fun rePresent(historyId: Long) {}
    fun approvedNotice(peerId: String, name: String?) {}
    fun renamedNotice(oldName: String?, newName: String) {}
    fun peerListChanged() {}
    fun deniedNotice(peerId: String) {}
    fun pauseNotice(peerId: String, paused: Boolean) {}
    fun selfRemoved(deleted: Boolean) {}
}

enum class PairNoticeKind { COMMIT, COMPARE, READY, IN_PROGRESS, PAIR_AGAIN }
