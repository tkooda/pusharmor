package com.pusharmor.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.TextButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.lifecycle.lifecycleScope
import com.pusharmor.net.ErrorText
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Detect
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.SizeCap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Share sheet entry (section 7): ACTION_SEND text/plain. */
class ShareActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
        if (text == null) { finish(); return }
        // The dialog shows at once: a placeholder until the peer read returns, never a blank box.
        setContent { Frame { CircularProgressIndicator(Modifier.padding(24.dp)) } }
        // A floating dialog nearly as wide as the screen, as tall as its content (I597); a tap outside cancels.
        // After setContent: installing the window's views resets a floating window to wrap its content.
        window.setLayout((resources.displayMetrics.widthPixels * DIALOG_WIDTH).toInt(), WindowManager.LayoutParams.WRAP_CONTENT)
        setFinishOnTouchOutside(true)
        lifecycleScope.launch {
            // Room refuses main-thread reads.
            val update = withContext(Dispatchers.IO) { vm.g.settings.updateRequired(com.pusharmor.app.BuildConfig.VERSION_NAME) }
            // Q349: this version got HTTP 426, so the share sheet shows the update screen, never a send that fails.
            if (update) { showUpdate(); return@launch }
            val all = withContext(Dispatchers.IO) {
                if (!canShare(vm.g.identity() != null, vm.g.settings.flag(com.pusharmor.app.data.Settings.K.SIGNED_OUT, false))) null
                else vm.g.store.peers().filter { it.inAll }
            }
            // Logged out or not set up: the app opens at log in, never a Send screen that cannot send (I470).
            if (all == null) { startActivity(Intent(this@ShareActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); finish() }
            else show(text, all)
        }
    }

    private fun show(text: String, all: List<Peer>) {
        // Another app can start this activity, so it never sends on its own: the target is only preselected
        // and the user must tap Send.
        val direct = directTarget(intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID), all.map { it.id })
        val tooLong = SizeCap.utf8Size(text) > SizeCap.MAX_CONTENT_BYTES
        val type = Detect.type(text)
        setContent {
            Frame {
                var cut by remember { mutableStateOf<String?>(null) }
                Column {
                    Text("Send", Modifier.padding(start = 24.dp, end = 24.dp, top = 24.dp), style = MaterialTheme.typography.headlineSmall)
                    if (tooLong && cut == null) Column(Modifier.verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(UiText.shareTooLong(SizeCap.utf8Size(text), type == ContentType.TEXT))
                        // Dialog buttons at the end, as in a standard dialog (I603).
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                            TextButton(onClick = { finish() }) { Text("Close") }
                            if (type == ContentType.TEXT) TextButton(onClick = { cut = SizeCap.truncateUtf8(text) }) { Text("Send the first 2048 bytes") }
                        }
                    } else Column(Modifier.padding(horizontal = 8.dp, vertical = 8.dp)) {
                        SendScreen(vm, cut ?: text, preselect = direct, inDialog = true, onPair = {
                            startActivity(MainActivity.openIntent(this@ShareActivity, "peers").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); finish()
                        }) { r -> if (r.text == ErrorText.UPDATE) showUpdate() else if (r.ok) toastAndFinish(r.text) }
                    }
                }
            }
        }
    }

    /** The dialog card: stock Material3 dialog shape and color, at most 90% of the screen tall (I597). */
    @Composable
    private fun Frame(content: @Composable () -> Unit) {
        AppTheme(vm) {
            Surface(Modifier.fillMaxWidth().heightIn(max = LocalConfiguration.current.screenHeightDp.dp * DIALOG_MAX_HEIGHT),
                shape = AlertDialogDefaults.shape, color = AlertDialogDefaults.containerColor, tonalElevation = AlertDialogDefaults.TonalElevation,
                content = content)
        }
    }

    companion object {
        /** The share sheet shows Send only for a registered device that is not logged out (I470). */
        fun canShare(registered: Boolean, signedOut: Boolean): Boolean = registered && !signedOut

        /** Preselected target: a shortcut id that is in the All set, else the only All peer, else null. Never sent without a tap. */
        fun directTarget(shortcutId: String?, allIds: List<String>): String? =
            if (shortcutId != null && shortcutId in allIds) shortcutId else allIds.singleOrNull()

        /** Dialog width and largest height, as parts of the screen (I597). */
        const val DIALOG_WIDTH = 0.94f
        const val DIALOG_MAX_HEIGHT = 0.9f
    }

    private fun showUpdate() {
        setContent { Frame { UpdateScreen(Modifier.padding(vertical = 24.dp)) } }
    }

    /** A send that reached a device returns the user to the sharing app; this activity is gone, so a Toast says so (I596). */
    private fun toastAndFinish(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
        finish()
    }

}
