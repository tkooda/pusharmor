package com.pusharmor.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.pusharmor.app.PaApp
import com.pusharmor.app.notify.Notifier
import com.pusharmor.app.work.Work

/**
 * FCM data-only messages. Every push ends with a visible notification, but for the relay server's silent test push. Decrypt, verify and
 * inflate run inline (milliseconds; handler limit 10 s); network work goes to WorkManager.
 */
class FcmService : FirebaseMessagingService() {
    private val g get() = (application as PaApp).graph

    override fun onMessageReceived(message: RemoteMessage) {
        if (PushDispatcher.isCheck(message.data)) return
        PushDispatcher.onPush(g, message.data["m"], fcm = true)
    }

    override fun onNewToken(token: String) {
        // The push state is in the database: a damaged one drops this token (startup fetches it again) instead of crashing the app.
        try { (g.push as? FlavorPush)?.onToken(g, token) } catch (e: android.database.SQLException) { android.util.Log.w("PushArmor", "push token not saved", e) }
    }

    override fun onDeletedMessages() {
        Work.fetchPeers(applicationContext, g.settings)
        g.notifier.peersNotice("Some messages were not delivered", Notifier.UNDELIVERED_ID)
    }
}
