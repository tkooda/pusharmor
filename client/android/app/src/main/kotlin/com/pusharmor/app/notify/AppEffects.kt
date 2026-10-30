package com.pusharmor.app.notify

import com.pusharmor.app.Graph
import com.pusharmor.app.ui.UiText
import com.pusharmor.app.work.Work
import com.pusharmor.protocol.ShownContent
import com.pusharmor.protocol.engine.Effects
import com.pusharmor.protocol.engine.PairNoticeKind

/**
 * Maps engine effects to notifications and work. [fcm]: the push came over FCM, which needs a
 * notification for every push; UnifiedPush stays silent for drops and control types.
 */
class AppEffects(private val g: Graph, private val fcm: Boolean) : Effects {
    private val n get() = g.notifier

    private fun nameOf(peerId: String): String = g.dao.peer(peerId)?.name ?: "A device"

    override fun schedulePairSend(peerId: String, replace: Boolean) = Work.pairSend(g.app, peerId, replace)
    override fun reconcileSoon() = Work.reconcile(g.app)
    override fun fetchPeersSoon() = Work.fetchPeers(g.app, g.settings)
    override fun peerChannelCreate(peerId: String) = n.createPeerChannel(peerId)
    override fun peerChannelDelete(peerId: String) = n.deletePeerChannel(peerId)
    override fun peerChannelRename(peerId: String) = n.renamePeerChannel(peerId)

    override fun pairNotice(peerId: String, pk: String, kind: PairNoticeKind, fingerprint: String?) {
        val x = g.dao.peer(peerId)?.let { it.name ?: "${platformLabel(it.platform)} device added ${dateLabel(it.created)}" } ?: "A device"
        when (kind) {
            PairNoticeKind.COMMIT -> n.pairNotice(pk, "A new device wants to pair. Open PushArmor.", peerId)
            PairNoticeKind.COMPARE -> n.pairNotice(pk, "New device: compare ${fingerprint ?: ""}", peerId)
            PairNoticeKind.READY -> if (fcm) n.pairNotice(pk, "Pairing fingerprint ready. Open PushArmor.", peerId)
            PairNoticeKind.IN_PROGRESS -> if (fcm) n.pairNotice(pk, "Pairing with $x in progress. Open PushArmor.", peerId)
            PairNoticeKind.PAIR_AGAIN -> n.pairNotice(pk, UiText.pairAgainNotice(x), peerId, highlight = true, ok = true)
        }
    }

    override fun cancelPairNotice(pk: String) = n.cancelPair(pk)
    override fun couldNotRead() { if (fcm) n.notice(Notifier.COULD_NOT_READ) }
    override fun invalidMessage() { if (fcm) n.notice(Notifier.INVALID) }
    override fun showContent(historyId: Long, peerId: String, content: ShownContent) = n.content(historyId, peerId, content)
    override fun rePresent(historyId: Long) = n.rePresent(historyId)
    override fun approvedNotice(peerId: String, name: String?) = n.peersNotice("${name ?: "A device"} approved this device", 3)
    override fun renamedNotice(oldName: String?, newName: String) = n.peersNotice("'${oldName ?: "A device"}' renamed to '$newName'", 4)
    override fun peerListChanged() = n.peersNotice("Device list changed", 5)
    override fun deniedNotice(peerId: String) { if (fcm) n.notice("${nameOf(peerId)} denied this device") }
    override fun logoutNotice(peerId: String, loggedOut: Boolean) {
        if (fcm) n.notice(if (loggedOut) "${nameOf(peerId)} logged out" else "${nameOf(peerId)} logged in")
    }
    override fun selfRemoved(deleted: Boolean) = g.session.selfRemoved(deleted = deleted, lostKeys = false)

    companion object {
        fun platformLabel(p: String) = when (p) { "android" -> "Android"; "ios" -> "iPhone"; "chrome" -> "Chrome"; "firefox" -> "Firefox"; else -> p }
        fun dateLabel(created: Long): String = java.text.SimpleDateFormat("MMM d", java.util.Locale.US).format(java.util.Date(created * 1000))
    }
}
