package com.pusharmor.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.NotificationManager

/** Non-exported receiver for notice taps and "OK": it only cancels the notification. */
class NoticeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val tag = intent.getStringExtra("tag") ?: return
        context.getSystemService(NotificationManager::class.java).cancel(tag, intent.getIntExtra("id", 0))
    }
}
