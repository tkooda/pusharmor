package com.pusharmor.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.width
import com.pusharmor.app.ui.theme.BrandGreen
import com.pusharmor.app.ui.theme.BrandTile
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.lifecycle.lifecycleScope
import com.pusharmor.net.ErrorText
import com.pusharmor.protocol.Detect
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.SizeCap
import com.pusharmor.protocol.engine.SendFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Share sheet entry (section 7): ACTION_SEND text/plain, or any file (EXTRA_STREAM) up to the file cap. */
class ShareActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val file = sharedFile(intent)
        val text = if (file != null) "" else intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
        if (text == null) { Toast.makeText(this, UiText.brief(UiText.SHARE_NOTHING), Toast.LENGTH_LONG).show(); finish(); return }
        // The dialog shows at once: a placeholder until the peer read returns, never a blank box.
        setContent { Frame { LinearProgressIndicator(Modifier.fillMaxWidth().padding(24.dp), color = BrandGreen) } }
        // A floating dialog nearly as wide as the screen, as tall as its content; a tap outside cancels.
        // After setContent: installing the window's views resets a floating window to wrap its content.
        window.setLayout((resources.displayMetrics.widthPixels * DIALOG_WIDTH).toInt(), WindowManager.LayoutParams.WRAP_CONTENT)
        setFinishOnTouchOutside(true)
        lifecycleScope.launch {
            // Room refuses main-thread reads.
            val update = withContext(Dispatchers.IO) { vm.g.settings.updateRequired(com.pusharmor.app.BuildConfig.VERSION_NAME) }
            // this version got HTTP 426, so the share sheet shows the update screen, never a send that fails.
            if (update) { showUpdate(); return@launch }
            var loggedOut = false
            val all = withContext(Dispatchers.IO) {
                try {
                    if (!canShare(vm.g.identity() != null, vm.g.settings.flag(com.pusharmor.app.data.Settings.K.SIGNED_OUT, false))) { loggedOut = true; null }
                    else vm.g.store.peers().filter { it.inAll }
                } catch (e: android.database.SQLException) { null }
            }
            // Logged out or not set up: a toast says why, and the app opens at log in, never a Send screen that cannot
            // send. A damaged database opens the app on its data screen.
            if (all == null) {
                if (loggedOut) Toast.makeText(this@ShareActivity, UiText.brief(UiText.SHARE_LOGGED_OUT), Toast.LENGTH_LONG).show()
                startActivity(Intent(this@ShareActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); finish()
            }
            else show(text, all, file)
        }
    }

    private fun show(text: String, all: List<Peer>, file: android.net.Uri? = null) {
        // A Direct Share target (a device's shortcut) sends at once; the app icon opens the Send screen. A file always opens the Send screen.
        val shortcut = if (file != null) null else directShortcut(intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID), all.map { it.id }, text)
        if (shortcut != null) { sendDirect(all.first { it.id == shortcut }, text); return }
        // The app icon (no shortcut id) only preselects the target; the user must tap Send.
        val direct = directTarget(intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID), all.map { it.id })
        // A file that is too large or cannot be read: its toast, and the dialog closes instead of showing an empty Send.
        var hadFile = false
        if (file != null) lifecycleScope.launch { vm.files.chosen.collect { if (it != null) hadFile = true } }
        if (file != null) lifecycleScope.launch {
            vm.message.collect { m ->
                if (m != null) {
                    vm.message.value = null
                    Toast.makeText(this@ShareActivity, UiText.brief(m), Toast.LENGTH_LONG).show()
                    // only a shared file that never showed closes the dialog; after Remove file it stays
                    if (!hadFile && vm.files.chosen.value == null) finish()
                }
            }
        }
        setContent {
            Frame {
                Column {
                    Text("Send", Modifier.padding(start = 24.dp, end = 24.dp, top = 24.dp), style = MaterialTheme.typography.headlineSmall)
                    // A message over the cap shows with Send greyed; the counter says why.
                    Column(Modifier.padding(horizontal = 8.dp, vertical = 8.dp)) {
                        SendScreen(vm, text, preselect = direct, inDialog = true, onPair = {
                            startActivity(MainActivity.openIntent(this@ShareActivity, "peers").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); finish()
                        }, initialFile = file) { r -> if (r.text.endsWith(ErrorText.UPDATE)) showUpdate() else if (r.ok) toastAndFinish(r.text) }
                    }
                }
            }
        }
    }

    /** The dialog card: stock Material3 dialog shape and color, at most 90% of the screen tall. */
    @Composable
    private fun Frame(content: @Composable () -> Unit) {
        AppTheme(vm) {
            Surface(Modifier.fillMaxWidth().heightIn(max = LocalConfiguration.current.screenHeightDp.dp * DIALOG_MAX_HEIGHT),
                shape = AlertDialogDefaults.shape, color = AlertDialogDefaults.containerColor, tonalElevation = AlertDialogDefaults.TonalElevation,
                content = content)
        }
    }

    companion object {
        /** The shared file: EXTRA_STREAM of a share that is not plain text; null for text. */
        fun sharedFile(i: Intent): android.net.Uri? {
            if (i.type == "text/plain" && i.hasExtra(Intent.EXTRA_TEXT)) return null
            @Suppress("DEPRECATION")
            return i.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)
        }

        /** The share sheet shows Send only for a registered device that is not logged out. */
        fun canShare(registered: Boolean, signedOut: Boolean): Boolean = registered && !signedOut

        /** Preselected target: a shortcut id that is in the All set, else the only All peer, else null. Never sent without a tap. */
        fun directTarget(shortcutId: String?, allIds: List<String>): String? =
            if (shortcutId != null && shortcutId in allIds) shortcutId else allIds.singleOrNull()

        /** A shortcut id in the All set with a message to send that fits the cap: that device gets the message with no Send screen. Else null.
         *  A message over the cap opens the Send screen instead, so the user can shorten it. */
        fun directShortcut(shortcutId: String?, allIds: List<String>, text: String): String? =
            if (shortcutId != null && shortcutId in allIds && text.isNotBlank() && SizeCap.utf8Size(text) <= SizeCap.MAX_CONTENT_BYTES) shortcutId else null

        /** Dialog width and largest height, as parts of the screen. */
        const val DIALOG_WIDTH = 0.94f
        const val DIALOG_MAX_HEIGHT = 0.9f
    }

    private fun showUpdate() {
        setContent { Frame { UpdateScreen(Modifier.padding(vertical = 24.dp)) } }
    }

    /** The type is detected as on the Send screen. A send that reached the device shows a toast; a failure posts an error notification. */
    private fun sendDirect(peer: Peer, text: String) {
        val caption = UiText.directSending(Detect.type(text), label(peer))
        // The step under the bar: encrypting, sending, or a retry of the relay server call.
        setContent {
            Frame {
                Column(Modifier.padding(24.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        BrandTile(40.dp)
                        Text(caption, Modifier.padding(start = 16.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                    LinearProgressIndicator({ vm.sendStep / 100f }, Modifier.fillMaxWidth().padding(top = 16.dp), color = BrandGreen)
                    Text(when {
                        vm.sendRetry > 1 -> UiText.tryingAgain(vm.sendRetry)
                        vm.sendStep < SendFlow.Step.ENCRYPTED -> UiText.encryptingFor(label(peer))
                        else -> UiText.sendingTo(label(peer))
                    }, Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        // The send runs outside this activity: a rotation does not send it again, and a tap outside neither stops it nor hides its result.
        val app = applicationContext
        val notifier = vm.g.notifier
        vm.sendDirect(peer.id, text) { r ->
            if (r.ok) Toast.makeText(app, UiText.brief(UiText.directShareSent(label(peer))), Toast.LENGTH_SHORT).show()
            else {
                val n = notifier
                // With notifications off or the channel blocked the notification cannot show, so the error is a toast:
                // a failure is never silent.
                if (n.noticeShows()) n.notice(r.text) else Toast.makeText(app, UiText.brief(r.text), Toast.LENGTH_LONG).show()
            }
        }
        lifecycleScope.launch { vm.directDone.first { it }; finish() }
    }

    /** A send that reached a device returns the user to the sharing app; this activity is gone, so a Toast says so. */
    private fun toastAndFinish(text: String) {
        Toast.makeText(this, UiText.brief(text), Toast.LENGTH_SHORT).show()
        finish()
    }

}
