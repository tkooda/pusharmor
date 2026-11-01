package com.pusharmor.app.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.pusharmor.app.R
import com.pusharmor.app.data.Settings
import com.pusharmor.app.ui.MainActivity
import com.pusharmor.crypto.B64url
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.ShownContent
import com.pusharmor.store.PaDao
import com.pusharmor.store.PeerEntity
import java.security.SecureRandom

/** Notification channels, ids and builders (section 6). */
class Notifier(private val context: Context, private val settings: Settings, private val dao: PaDao) {
    companion object {
        /** Brand navy accent on every notification (small icon tint and actions). */
        const val NAVY = 0xFF1F3A5F.toInt()
        const val DEFAULT_CHANNEL = "default"
        const val TAG_MSG = "msg"
        const val TAG_NOTICE = "notice"
        const val TAG_PAIR = "pair"
        const val NOTICE_ID = 1
        const val UNDELIVERED_ID = 2
        const val GROUP_PREFIX = "group:"

        const val COULD_NOT_READ = "PushArmor received a message it could not read"
        const val INVALID = "Invalid message received"

        fun randomChannelId(): String = B64url.encode(ByteArray(16).also { SecureRandom().nextBytes(it) })

        /** Notification id derived from the pairing key pk (first 4 bytes, positive). */
        fun pairId(pk: String): Int {
            val b = B64url.decode(pk)
            return (((b[0].toInt() and 0x7F) shl 24) or ((b[1].toInt() and 0xFF) shl 16) or ((b[2].toInt() and 0xFF) shl 8) or (b[3].toInt() and 0xFF))
        }
    }

    private val nm = context.getSystemService(NotificationManager::class.java)

    /** Created on first start; "messages" and "peers" ids are random per install, kept in DataStore. */
    fun ensureChannels() {
        nm.createNotificationChannel(NotificationChannel(DEFAULT_CHANNEL, "Other", NotificationManager.IMPORTANCE_NONE))
        val msg = settings.get(Settings.K.CH_MESSAGES) ?: randomChannelId().also { settings.set(Settings.K.CH_MESSAGES, it) }
        val peers = settings.get(Settings.K.CH_PEERS) ?: randomChannelId().also { settings.set(Settings.K.CH_PEERS, it) }
        nm.createNotificationChannel(NotificationChannel(msg, "Messages", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(peers, "Devices", NotificationManager.IMPORTANCE_DEFAULT))
    }

    val messagesChannel: String get() = settings.get(Settings.K.CH_MESSAGES)!!
    val peersChannel: String get() = settings.get(Settings.K.CH_PEERS)!!

    /** Per-peer channel: created at pairing, renamed on rename, deleted at removal. */
    fun createPeerChannel(peerId: String) {
        val p = dao.peer(peerId) ?: return
        val id = p.channelId ?: randomChannelId().also { dao.putPeer(p.copy(channelId = it)) }
        nm.createNotificationChannel(NotificationChannel(id, p.name ?: "Device", NotificationManager.IMPORTANCE_HIGH))
    }

    fun renamePeerChannel(peerId: String) {
        val p = dao.peer(peerId) ?: return
        val id = p.channelId ?: return
        nm.createNotificationChannel(NotificationChannel(id, p.name ?: "Device", NotificationManager.IMPORTANCE_HIGH))
    }

    fun deletePeerChannel(peerId: String) {
        val p = dao.peer(peerId) ?: return
        p.channelId?.let { nm.deleteNotificationChannel(it) }
    }

    fun deleteAllPeerChannels() {
        for (p in dao.peers()) p.channelId?.let { nm.deleteNotificationChannel(it) }
    }

    fun blockedChannelPeer(peers: List<PeerEntity>): String? = peers.firstOrNull { p ->
        p.channelId?.let { nm.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE } == true
    }?.let { it.name ?: "a device" }

    fun mainChannelsBlocked(): Boolean = listOfNotNull(settings.get(Settings.K.CH_MESSAGES), settings.get(Settings.K.CH_PEERS))
        .any { nm.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE }

    fun enabled() = NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun openApp(route: String, extra: String? = null): PendingIntent {
        val i = MainActivity.openIntent(context, route).setAction("open:$route:${extra ?: ""}")
            .putExtra("peer", extra).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, route.hashCode() xor (extra?.hashCode() ?: 0), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun dismiss(tag: String, id: Int): PendingIntent {
        val i = Intent(context, NoticeReceiver::class.java).setAction("dismiss:$tag:$id").putExtra("tag", tag).putExtra("id", id)
        return PendingIntent.getBroadcast(context, id xor tag.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun notify(tag: String, id: Int, n: Notification) {
        if (!enabled()) return
        try { nm.notify(tag, id, n) } catch (e: SecurityException) { /* permission revoked */ }
    }

    /** Fixed-form notices (deny, logout, login, could not read, invalid): one id, tag "notice", "OK" only; a tap only dismisses. */
    fun notice(text: String) {
        val dismiss = dismiss(TAG_NOTICE, NOTICE_ID)
        notify(TAG_NOTICE, NOTICE_ID, NotificationCompat.Builder(context, peersChannel)
            .setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("PushArmor").setContentText(text)
            .setContentIntent(dismiss).setAutoCancel(true)
            .addAction(0, "OK", dismiss).build())
    }

    fun peersNotice(text: String, id: Int = UNDELIVERED_ID) {
        notify(TAG_NOTICE, id, NotificationCompat.Builder(context, peersChannel)
            .setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("PushArmor").setContentText(text)
            .setContentIntent(openApp("peers")).setAutoCancel(true).build())
    }

    /** Pairing notices under the id from pk (tag "pair"). */
    fun pairNotice(pk: String, text: String, peerId: String?, highlight: Boolean = false, ok: Boolean = false) {
        val id = pairId(pk)
        val b = NotificationCompat.Builder(context, peersChannel)
            .setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("PushArmor").setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp("peers", if (highlight) peerId else null)).setAutoCancel(true)
        if (ok) b.addAction(0, "OK", dismiss(TAG_PAIR, id))
        notify(TAG_PAIR, id, b.build())
    }

    fun cancelPair(pk: String) = nm.cancel(TAG_PAIR, pairId(pk))

    fun cancel(tag: String, id: Int) = nm.cancel(tag, id)

    private fun action(historyId: Long, act: String): PendingIntent {
        val i = Intent(context, ActionActivity::class.java).setAction("$act:$historyId").putExtra("history", historyId).putExtra("act", act)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, (historyId.toInt() shl 3) xor act.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** url / text / tel (no sender name, Q12 A; except "New message from $peer" when hidden, Q187). */
    fun content(historyId: Long, peerId: String, c: ShownContent) {
        val peer = dao.peer(peerId)
        val policy = Policy.of(settings.lockScreen, peer?.lockScreen ?: true, settings.watch, peer?.watch ?: true, !settings.showContent, peer?.hideContent ?: false)
        val channel = peer?.channelId?.takeIf { nm.getNotificationChannel(it) != null } ?: messagesChannel
        val b = NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setAutoCancel(true)
            .setGroup(GROUP_PREFIX + channel).setLocalOnly(policy.localOnly)
        val open = action(historyId, "item")
        if (policy.hideAll) {
            b.setContentTitle("New message from ${peer?.name ?: "a device"}").setContentIntent(open)
        } else {
            val (title, body) = when {
                c.type == ContentType.URL && !c.showAsText -> "Link" to (c.href ?: c.value)
                c.type == ContentType.TEL && c.canDial -> "Phone number" to c.value
                else -> "Text" to c.value
            }
            b.setContentTitle(title).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            when {
                c.type == ContentType.URL && !c.showAsText -> {
                    b.setContentIntent(if (settings.tapOpensLink) action(historyId, "open") else open)
                    b.addAction(0, "Open", action(historyId, "open")).addAction(0, "Copy", action(historyId, "copy")).addAction(0, "Share", action(historyId, "share"))
                }
                c.type == ContentType.TEL && c.canDial -> {
                    b.setContentIntent(open).addAction(0, "Call", action(historyId, "dial")).addAction(0, "Copy", action(historyId, "copy"))
                }
                else -> b.setContentIntent(open).addAction(0, "Copy", action(historyId, "copy")).addAction(0, "Share", action(historyId, "share"))
            }
            if (policy.privateOnLockScreen) {
                b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                b.setPublicVersion(NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("New message").build())
            }
        }
        notify(TAG_MSG, historyId.toInt(), b.build())
        summary(channel, policy)
    }

    /** One summary per channel: no content, localOnly if a child is, strictest visibility. */
    private fun summary(channel: String, child: Policy) {
        val b = NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_notify).setColor(NAVY)
            .setGroup(GROUP_PREFIX + channel).setGroupSummary(true).setLocalOnly(child.localOnly)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        notify(TAG_MSG, -(channel.hashCode() and 0x7FFFFFFF) - 1, b.build())
    }

    fun rePresent(historyId: Long) {
        val h = dao.history(historyId) ?: return
        val text = h.content ?: return
        val u = com.pusharmor.protocol.UrlCheck.parse(text)
        val c = ShownContent(ContentType.entries.firstOrNull { it.key == h.type } ?: return, text, u?.href, u?.host)
        content(historyId, h.peerId ?: return, c)
    }

    fun cancelAll() = nm.cancelAll()
}
