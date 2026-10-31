package com.pusharmor.protocol.engine

import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.ReplayWindow

/** In-memory LocalStore; one lock = one transaction. A "restart" reuses the same instance. */
class MemStore(var name: String = "This device") : LocalStore {
    private val lock = Any()
    val peers = LinkedHashMap<String, Peer>()
    val windows = HashMap<String, Pair<ByteArray, ReplayWindow>>()
    val pairingRows = LinkedHashMap<String, PairingRow>()
    val cap = ArrayList<Long>()
    val allow = LinkedHashSet<String>()
    val history = ArrayList<HistoryRow>()

    override fun <T> tx(block: () -> T): T = synchronized(lock) { block() }
    override fun peer(id: String) = synchronized(lock) { peers[id] }
    override fun peers() = synchronized(lock) { peers.values.toList() }
    override fun putPeer(p: Peer) { synchronized(lock) { peers[p.id] = peers[p.id]?.let { p.copy(lastN = it.lastN) } ?: p } }
    override fun resetCounter(peerId: String) { synchronized(lock) { peers[peerId]?.let { peers[peerId] = it.copy(lastN = 0) } } }
    override fun deletePeer(id: String) { synchronized(lock) { peers.remove(id) } }
    override fun reserveCounter(peerId: String): Long = synchronized(lock) {
        val p = peers[peerId]!!
        val n = p.lastN + 1
        peers[peerId] = p.copy(lastN = n)
        n
    }
    override fun window(peerId: String) = synchronized(lock) { windows[peerId]?.second }
    override fun putWindow(peerId: String, pairingId: ByteArray, w: ReplayWindow) { synchronized(lock) { windows[peerId] = pairingId to w } }
    override fun deleteWindow(peerId: String) { synchronized(lock) { windows.remove(peerId) } }
    override fun pairing(peerId: String) = synchronized(lock) { pairingRows[peerId] }
    override fun pairings() = synchronized(lock) { pairingRows.values.toList() }
    override fun putPairing(r: PairingRow) { synchronized(lock) { pairingRows[r.peerId] = r } }
    override fun deletePairing(peerId: String) { synchronized(lock) { pairingRows.remove(peerId) } }
    override fun capTimestamps() = synchronized(lock) { cap.toList() }
    override fun addCapTimestamp(t: Long) { synchronized(lock) { cap.add(t) } }
    override fun allowSet() = synchronized(lock) { allow.toSet() }
    override fun replaceAllowSet(ids: Collection<String>) { synchronized(lock) { allow.clear(); allow.addAll(ids) } }
    override fun addAllow(id: String) { synchronized(lock) { allow.add(id) } }
    override fun removeAllow(id: String) { synchronized(lock) { allow.remove(id) } }
    override fun historyIdFor(peerId: String, pairingId: ByteArray, n: Long) = synchronized(lock) {
        history.firstOrNull { it.peerId == peerId && it.n == n && it.pairingId?.contentEquals(pairingId) == true }?.id
    }
    override fun insertHistory(row: HistoryRow): Long = synchronized(lock) {
        val id = history.size + 1L
        history.add(row.copy(id = id))
        id
    }
    override fun ownName() = name
}

/** Records effects for assertions. */
class RecEffects : Effects {
    val log = ArrayList<String>()
    override fun schedulePairSend(peerId: String, replace: Boolean) { log.add("send:$replace") }
    override fun reconcileSoon() { log.add("reconcile") }
    override fun fetchPeersSoon() { log.add("fetch") }
    override fun pairNotice(peerId: String, pk: String, kind: PairNoticeKind, fingerprint: String?) { log.add("pair:$kind:$pk:${fingerprint ?: ""}") }
    override fun couldNotRead() { log.add("couldNotRead") }
    override fun invalidMessage() { log.add("invalid") }
    override fun showContent(historyId: Long, peerId: String, content: com.pusharmor.protocol.ShownContent) { log.add("show:${content.value}") }
    override fun rePresent(historyId: Long) { log.add("represent:$historyId") }
    override fun approvedNotice(peerId: String, name: String?) { log.add("approved:$name") }
    override fun logoutNotice(peerId: String, loggedOut: Boolean) { log.add("logout:$loggedOut") }
    override fun deniedNotice(peerId: String) { log.add("denied") }
    override fun selfRemoved(deleted: Boolean) { log.add("selfRemoved:$deleted") }
}
