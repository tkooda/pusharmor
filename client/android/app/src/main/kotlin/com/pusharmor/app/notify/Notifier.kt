package com.pusharmor.app.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.pusharmor.app.R
import com.pusharmor.app.data.Settings
import com.pusharmor.app.ui.MainActivity
import com.pusharmor.app.ui.UiText
import com.pusharmor.crypto.B64url
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.ShownContent
import com.pusharmor.store.PaDao
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.toPeer
import java.security.SecureRandom

/** Notification channels, ids and builders (section 6). */
class Notifier(private val context: Context, private val settings: Settings, private val dao: PaDao) {
    companion object {
        /** Brand navy accent on every notification (small icon tint and actions). */
        const val NAVY = 0xFF1F3A5F.toInt()
        /** A notice shows only with notifications on and the "peers" channel not blocked. */
        fun noticeShows(enabled: Boolean, peersImportance: Int?): Boolean = enabled && peersImportance != NotificationManager.IMPORTANCE_NONE
        const val DEFAULT_CHANNEL = "default"
        const val TAG_MSG = "msg"
        const val MAX_MESSAGES = 25
        const val TAG_NOTICE = "notice"
        const val TAG_PAIR = "pair"
        const val NOTICE_ID = 1
        const val UNDELIVERED_ID = 2
        /** Notices that devices deleted messages here; no other notice uses it. */
        const val DELETED_ID = 6
        /** The progress of a Direct Share file send; no other notice uses it. */
        const val SENDING_ID = 7
        /** Dels of one delete all arrive within this time; their counts add up in one notice. */
        const val DELETED_JOIN_MS = 60_000L
        private const val EXTRA_DELETED_PEER = "pa_deleted_peer"
        private const val EXTRA_DELETED_COUNT = "pa_deleted_count"
        const val GROUP_PREFIX = "group:"
        /** A post this process made still counts this long while the system list does not show it yet. */
        const val POST_LAG_MS = 5_000L

        const val COULD_NOT_READ = "Unable to read a message.\nIt is not valid or was damaged."
        const val INVALID = "Invalid message received"

        /** Group of the per-device message channels, as the system settings list it. */
        const val PEER_GROUP = "device_messages"

        /** A device's name as the app shows it: its name, else "Android device added Nov 4". */
        fun deviceName(p: PeerEntity): String = p.name ?: "${AppEffects.platformLabel(p.platform)} device added ${AppEffects.dateLabel(p.created)}"

        /**
         * The system keeps the group a channel was made with, so a per-device channel outside [PEER_GROUP] is made again
         * under the new [id], with the importance, sound, vibration, and lights the user set on [old].
         */
        fun regrouped(old: NotificationChannel, id: String, name: String): NotificationChannel =
            NotificationChannel(id, name, old.importance).also { c ->
                c.group = PEER_GROUP
                c.setSound(old.sound, old.audioAttributes)
                old.vibrationPattern?.let { c.vibrationPattern = it }
                c.enableVibration(old.shouldVibrate())
                c.enableLights(old.shouldShowLights())
                c.lightColor = old.lightColor
            }

        fun randomChannelId(): String = B64url.encode(ByteArray(16).also { SecureRandom().nextBytes(it) })

        /** Notification id derived from the pairing key pk (first 4 bytes, positive). */
        fun pairId(pk: String): Int {
            val b = B64url.decode(pk)
            return (((b[0].toInt() and 0x7F) shl 24) or ((b[1].toInt() and 0xFF) shl 16) or ((b[2].toInt() and 0xFF) shl 8) or (b[3].toInt() and 0xFF))
        }
    }

    private val nm = context.getSystemService(NotificationManager::class.java)

    /** Message notification ids this process posted, with their post time; also the lock of post and trim. */
    private val posted = HashMap<Int, Long>()

    /** Created on first start; "messages" and "peers" ids are random per install, kept in DataStore. */
    fun ensureChannels() {
        nm.createNotificationChannel(NotificationChannel(DEFAULT_CHANNEL, "Not used", NotificationManager.IMPORTANCE_NONE))
        val msg = settings.get(Settings.K.CH_MESSAGES) ?: randomChannelId().also { settings.set(Settings.K.CH_MESSAGES, it) }
        val peers = settings.get(Settings.K.CH_PEERS) ?: randomChannelId().also { settings.set(Settings.K.CH_PEERS, it) }
        nm.createNotificationChannel(NotificationChannel(msg, "Messages", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(peers, "Pairing and device changes", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannelGroup(NotificationChannelGroup(PEER_GROUP, "Messages from devices"))
    }

    val messagesChannel: String get() = settings.get(Settings.K.CH_MESSAGES)!!
    val peersChannel: String get() = settings.get(Settings.K.CH_PEERS)!!

    /** Per-peer channel: created at pairing, renamed on rename, deleted at removal. */
    fun createPeerChannel(peerId: String) {
        val p = dao.peer(peerId) ?: return
        val id = p.channelId ?: randomChannelId().also { dao.setChannelId(peerId, it) }
        nm.createNotificationChannel(peerChannel(id, p))
    }

    private fun peerChannel(id: String, p: PeerEntity) =
        NotificationChannel(id, deviceName(p), NotificationManager.IMPORTANCE_HIGH).also { it.group = PEER_GROUP }

    /**
     * Brings every existing per-device channel to its device's current name; on app start and when the device list changes, never on a timer.
     * A channel an earlier version made outside the group is made again in it (see [regrouped]), and the old one is deleted.
     */
    fun syncPeerChannels() {
        nm.createNotificationChannelGroup(NotificationChannelGroup(PEER_GROUP, "Messages from devices"))
        for (p in dao.peers()) {
            val id = p.channelId ?: continue
            val old = nm.getNotificationChannel(id)
            if (old == null || old.group == PEER_GROUP) { nm.createNotificationChannel(peerChannel(id, p)); continue }
            val new = randomChannelId()
            nm.createNotificationChannel(regrouped(old, new, deviceName(p)))
            dao.setChannelId(p.id, new)
            nm.deleteNotificationChannel(id)
        }
    }

    fun renamePeerChannel(peerId: String) {
        val p = dao.peer(peerId) ?: return
        val id = p.channelId ?: return
        nm.createNotificationChannel(peerChannel(id, p))
    }

    fun deletePeerChannel(peerId: String) {
        val p = dao.peer(peerId) ?: return
        p.channelId?.let { nm.deleteNotificationChannel(it) }
    }

    /** Wipe: the clear drops the "messages" and "peers" channel ids, so the old channels go first (else they stay in system settings). */
    fun deleteMainChannels() {
        for (k in listOf(Settings.K.CH_MESSAGES, Settings.K.CH_PEERS)) settings.get(k)?.let { nm.deleteNotificationChannel(it) }
    }

    fun deleteAllPeerChannels() {
        for (p in dao.peers()) p.channelId?.let { nm.deleteNotificationChannel(it) }
    }

    fun blockedChannelPeer(peers: List<PeerEntity>): PeerEntity? = peers.firstOrNull { p ->
        p.channelId?.let { nm.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE } == true
    }

    fun mainChannelsBlocked(): Boolean = listOfNotNull(settings.get(Settings.K.CH_MESSAGES), settings.get(Settings.K.CH_PEERS))
        .any { nm.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE }

    fun enabled() = NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** False when a [notice] cannot show: notifications off, or the "peers" channel blocked. */
    fun noticeShows(): Boolean = noticeShows(enabled(), settings.get(Settings.K.CH_PEERS)?.let { nm.getNotificationChannel(it)?.importance })

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
    fun notice(text: String, id: Int = NOTICE_ID, extras: android.os.Bundle? = null) {
        val dismiss = dismiss(TAG_NOTICE, id)
        val b = NotificationCompat.Builder(context, peersChannel)
            .setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("PushArmor").setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(dismiss).setAutoCancel(true)
            .addAction(0, "OK", dismiss)
        if (extras != null) b.addExtras(extras)
        notify(TAG_NOTICE, id, b.build())
    }

    /**
     * Notice that [peerId] deleted [count] messages here, under its own id. A notice of the same device still shown
     * from the last [DELETED_JOIN_MS] gets this count added, so a delete sent in several dels shows one total.
     */
    fun deletedNotice(peerId: String, count: Int, text: (Int) -> String) {
        val prev = try { nm.activeNotifications.firstOrNull { it.tag == TAG_NOTICE && it.id == DELETED_ID } } catch (e: Exception) { null }
        val e = prev?.notification?.extras
        val total = count + if (e != null && e.getString(EXTRA_DELETED_PEER) == peerId && System.currentTimeMillis() - prev.notification.`when` <= DELETED_JOIN_MS) e.getInt(EXTRA_DELETED_COUNT) else 0
        notice(text(total), DELETED_ID, android.os.Bundle().apply { putString(EXTRA_DELETED_PEER, peerId); putInt(EXTRA_DELETED_COUNT, total) })
    }

    /**
     * The progress of a Direct Share file send, [percent] of 0 to 100: the notification of
     * [com.pusharmor.app.files.DirectSendService], which goes with that service; it alerts once only.
     */
    fun sending(text: String, percent: Int): Notification = NotificationCompat.Builder(context, peersChannel)
        .setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("PushArmor").setContentText(text)
        .setProgress(100, percent, false).setOngoing(true).setOnlyAlertOnce(true).setSilent(true).build()

    /** A new percent for the service's [sending] notification (the same id, no tag). */
    fun sendingProgress(text: String, percent: Int) {
        if (!enabled()) return
        try { nm.notify(SENDING_ID, sending(text, percent)) } catch (e: SecurityException) { /* permission revoked */ }
    }

    fun peersNotice(text: String, id: Int = UNDELIVERED_ID) {
        notify(TAG_NOTICE, id, NotificationCompat.Builder(context, peersChannel)
            .setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("PushArmor").setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
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

    fun cancel(tag: String, id: Int) {
        if (tag != TAG_MSG) return nm.cancel(tag, id)
        synchronized(posted) {
            posted.remove(id)
            nm.cancel(tag, id)
            // a summary left without messages shows as a blank notification; a tap may have removed the message already
            val active = nm.activeNotifications.filter { it.tag == TAG_MSG }
            val groups = active.filter { it.id >= 0 }.map { it.notification.group }.toSet()
            active.filter { it.id < 0 && it.notification.group !in groups }.forEach { nm.cancel(TAG_MSG, it.id) }
        }
    }

    /** Every message notification and its group summary; notices, pairing notices, and status cards stay. */
    fun cancelMessages() {
        synchronized(posted) {
            // a post the system list does not show yet is cancelled too
            val ids = nm.activeNotifications.filter { it.tag == TAG_MSG }.map { it.id }.toSet() + posted.keys
            posted.clear()
            ids.forEach { nm.cancel(TAG_MSG, it) }
        }
    }

    private fun action(historyId: Long, act: String): PendingIntent {
        val i = Intent(context, ActionActivity::class.java).setAction("$act:$historyId").putExtra("history", historyId).putExtra("act", act)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, (historyId.toInt() shl 3) xor act.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** url / text / tel: the sender's device name in quotes over the message ("New message from $peer" when hidden). */
    fun content(historyId: Long, peerId: String, c: ShownContent) = post(historyId, peerId) { b, open ->
        val body = if (c.type == ContentType.URL && !c.showAsText) c.href ?: c.value else c.value
        b.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
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
    }

    /** A received file: its name as the text; a tap opens it in History. */
    fun file(historyId: Long, peerId: String, name: String) = post(historyId, peerId) { b, open -> b.setContentText(name).setContentIntent(open) }

    private fun post(historyId: Long, peerId: String, fill: (NotificationCompat.Builder, android.app.PendingIntent) -> Unit) {
        val peer = dao.peer(peerId)
        val policy = Policy.of(settings.lockScreen, peer?.lockScreen ?: true, settings.watch, peer?.watch ?: true, !settings.showContent, !(peer?.showContent ?: true))
        val channel = peer?.channelId?.takeIf { nm.getNotificationChannel(it) != null } ?: messagesChannel
        val b = NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setAutoCancel(true)
            .setGroup(GROUP_PREFIX + channel).setLocalOnly(policy.localOnly)
        val open = action(historyId, "item")
        if (policy.hideAll) {
            b.setContentTitle(UiText.newMessageFrom(peer?.name)).setContentIntent(open)
        } else {
            b.setContentTitle(UiText.messageTitle(peer?.let { com.pusharmor.app.ui.label(it.toPeer()) }))
            fill(b, open)
            if (policy.privateOnLockScreen) {
                b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                b.setPublicVersion(NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_notify).setColor(NAVY).setContentTitle("New message").build())
            }
        }
        synchronized(posted) {
            trimMessages(historyId.toInt())
            notify(TAG_MSG, historyId.toInt(), b.build())
            posted[historyId.toInt()] = System.currentTimeMillis()
        }
        summary(channel, policy)
    }

    /** At most [MAX_MESSAGES] message notifications: cancel the oldest ones; history is untouched. */
    private fun trimMessages(incoming: Int) {
        val now = System.currentTimeMillis()
        val shown = HashMap<Int, Long>()
        nm.activeNotifications.filter { it.tag == TAG_MSG && it.id >= 0 }.forEach { shown[it.id] = it.postTime }
        // a post the system list still leaves out after the lag was dismissed
        posted.entries.removeIf { it.key !in shown && now - it.value > POST_LAG_MS }
        posted.forEach { (id, t) -> shown[id] = maxOf(t, shown[id] ?: t) }
        shown.remove(incoming)
        val old = shown.entries.sortedWith(compareBy({ it.value }, { it.key }))
        old.take((old.size - (MAX_MESSAGES - 1)).coerceAtLeast(0)).forEach { posted.remove(it.key); nm.cancel(TAG_MSG, it.key) }
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

    fun cancelAll() {
        synchronized(posted) { posted.clear() }
        nm.cancelAll()
    }
}
