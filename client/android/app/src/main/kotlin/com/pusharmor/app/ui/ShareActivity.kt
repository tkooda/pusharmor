package com.pusharmor.app.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.lifecycle.lifecycleScope
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Detect
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.SizeCap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Share sheet entry (section 7): ACTION_SEND text/plain. */
class ShareActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
        if (text == null) { finish(); return }
        // The dialog shows at once: a placeholder until the peer read returns, never a blank box.
        setContent { AppTheme(vm) { Surface(color = MaterialTheme.colorScheme.background) { CircularProgressIndicator(Modifier.padding(24.dp)) } } }
        lifecycleScope.launch {
            // Room refuses main-thread reads.
            val all = withContext(Dispatchers.IO) { if (vm.g.identity() == null) null else vm.g.store.peers().filter { it.inAll } }
            if (all == null) finish() else show(text, all)
        }
    }

    private fun show(text: String, all: List<Peer>) {
        val direct = directTarget(intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID), all.map { it.id })
        val tooLong = SizeCap.utf8Size(text) > SizeCap.MAX_CONTENT_BYTES
        val type = Detect.type(text)
        if (!tooLong && direct != null) { send(listOf(direct), text); return }
        setContent {
            AppTheme(vm) { Surface(color = MaterialTheme.colorScheme.background) {
                var cut by remember { mutableStateOf<String?>(null) }
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (tooLong && cut == null) {
                        if (type == ContentType.TEXT) {
                            Text("Too long (${SizeCap.utf8Size(text)} / 2048)")
                            Button(onClick = { cut = SizeCap.truncateUtf8(text) }) { Text("Send the first 2048 bytes") }
                        } else {
                            Text("Too long (${SizeCap.utf8Size(text)} / 2048)")
                        }
                    } else {
                        SendScreen(vm, cut ?: text) { r -> toastAndFinish(r) }
                    }
                }
            } }
        }
    }

    companion object {
        /** Direct send target: a shortcut id that is in the All set, else the only All peer, else null (picker). */
        fun directTarget(shortcutId: String?, allIds: List<String>): String? =
            if (shortcutId != null && shortcutId in allIds) shortcutId else allIds.singleOrNull()
    }

    private fun send(ids: List<String>, text: String) {
        lifecycleScope.launch {
            val r = withTimeoutOrNull(10_000) { vm.send(ids, text, asText = false) }
            toastAndFinish(r ?: "Sending")
        }
    }

    private fun toastAndFinish(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
        finish()
    }

}
