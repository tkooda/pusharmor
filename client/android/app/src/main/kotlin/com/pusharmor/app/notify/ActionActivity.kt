package com.pusharmor.app.notify

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PersistableBundle
import android.widget.Toast
import com.pusharmor.app.PaApp
import com.pusharmor.app.ui.MainActivity
import com.pusharmor.protocol.UrlCheck

/**
 * No-UI activity for every notification tap and action (Android 12 trampoline rules): marks the
 * item read, then opens / dials / shares / copies, then finishes.
 */
class ActionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val g = (application as PaApp).graph
        val id = intent.getLongExtra("history", -1)
        val act = intent.getStringExtra("act") ?: "item"
        Thread {
            val h = g.dao.history(id)
            g.dao.markRead(id)
            runOnUiThread {
                g.notifier.cancel(Notifier.TAG_MSG, id.toInt())
                val c = h?.content
                if (c != null) run(act, c, id) else openHistory(id)
                finish()
            }
        }.start()
    }

    private fun run(act: String, content: String, id: Long) {
        when (act) {
            "open" -> {
                val u = UrlCheck.parse(content) ?: return openHistory(id)
                val i = Intent(Intent.ACTION_VIEW, Uri.parse(u.href)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try { startActivity(i) } catch (e: ActivityNotFoundException) { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show() }
            }
            "dial" -> startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(content))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            "share" -> startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, content), null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            "copy" -> copy(this, content)
            else -> openHistory(id)
        }
    }

    private fun openHistory(id: Long) {
        startActivity(Intent(this, MainActivity::class.java).putExtra("route", "history").putExtra("history", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
    }

    companion object {
        /** Clipboard copies are marked sensitive. */
        fun copy(activity: android.content.Context, text: String) {
            val clip = ClipData.newPlainText("PushArmor", text)
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
            activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        }
    }
}
