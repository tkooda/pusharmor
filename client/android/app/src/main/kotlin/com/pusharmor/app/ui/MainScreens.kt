package com.pusharmor.app.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings as SysSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.PackageManagerCompat
import androidx.core.content.IntentCompat
import com.pusharmor.app.data.Settings
import com.pusharmor.app.notify.AppEffects
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.notify.Policy
import com.pusharmor.app.push.UnifiedPushSupport
import com.pusharmor.protocol.Countdown
import com.pusharmor.protocol.Detect
import com.pusharmor.protocol.PairDecide
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.SizeCap
import com.pusharmor.protocol.engine.PairingEngine
import com.pusharmor.protocol.engine.PairingRow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private fun label(p: Peer) = p.name ?: "${AppEffects.platformLabel(p.platform)} peer added ${AppEffects.dateLabel(p.created)}"

/** Peers screen (section 8). */
@Composable
fun PeersScreen(vm: AppViewModel) {
    val peers by vm.peers.collectAsState()
    val rows by vm.pairings.collectAsState()
    val highlight by vm.highlight.collectAsState()
    val prefs by vm.prefs.collectAsState()
    val context = LocalContext.current
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var confirmRemove by remember { mutableStateOf<Peer?>(null) }
    LaunchedEffect(Unit) {
        vm.onPeersOpen()
        while (true) { delay(30_000); now = System.currentTimeMillis(); vm.onPeersOpen() } // timeout timer while open
    }
    val me by vm.self.collectAsState()
    val selfId = me?.id
    val list = peers.filter { it.id != selfId && !(it.removed && !it.pinned && rows.none { r -> r.peerId == it.id }) }
    val state = rememberLazyListState()
    LaunchedEffect(highlight, list.size) { highlight?.let { h -> list.indexOfFirst { it.id == h }.takeIf { it >= 0 }?.let { state.animateScrollToItem(it) } } }
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text(me?.name ?: "", style = MaterialTheme.typography.titleLarge)
        Banners(vm, prefs?.get(Settings.K.BANNER))
        val lastRefresh = prefs?.get(Settings.K.LAST_REFRESH) ?: 0
        OutlinedButton(onClick = { vm.refresh() }, enabled = now - lastRefresh >= 60_000) { Text("Refresh") }
        LazyColumn(state = state, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(list, key = { it.id }) { p ->
                PeerRow(vm, p, rows.firstOrNull { it.peerId == p.id }, now, p.id == highlight) { confirmRemove = p }
            }
        }
    }
    confirmRemove?.let { p ->
        val x = label(p)
        AlertDialog(onDismissRequest = { confirmRemove = null },
            text = { Text("Remove $x from this account? $x must sign in again and pair with every peer again.") },
            confirmButton = { TextButton(onClick = { vm.remove(p.id); confirmRemove = null }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text("Cancel") } })
    }
}

@Composable
private fun Banners(vm: AppViewModel, banner: String?) {
    val context = LocalContext.current
    val n = vm.g.notifier
    if (!n.enabled() || n.mainChannelsBlocked()) BannerRow("Notifications are off; messages will not be shown", "Fix") {
        context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
    }
    n.blockedChannelPeer(vm.peerEntities.collectAsState().value)?.let { BannerRow("Messages from $it are blocked", "Fix") {
        context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
    } }
    if (banner?.startsWith("no_distributor") == true) {
        BannerRow("Install a UnifiedPush app (we suggest ntfy)", "Get") {
            val url = if (vm.g.push.hasPlayServices) "https://play.google.com/store/apps/details?id=io.heckel.ntfy" else "https://f-droid.org/packages/io.heckel.ntfy/"
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
        if (vm.g.push.hasPlayServices) TextButton(onClick = { vm.switchPush(toUp = false) }) { Text("Switch back to Google") }
    }
    val s = vm.g.settings
    val upAt = s.get(Settings.K.UP_REGISTERED_AT)
    if (s.get(Settings.K.PUSH_TYPE) == "unifiedpush" && upAt != null && !s.flag(Settings.K.UP_VERIFIED, false) && System.currentTimeMillis() - upAt > 10 * 60_000) {
        BannerRow("This push server did not deliver; check your UnifiedPush app", "Retry") { vm.retryPush() }
        if (vm.g.push.hasPlayServices) TextButton(onClick = { vm.switchPush(toUp = false) }) { Text("Switch back to Google") }
    }
    val st = remember { try { PackageManagerCompat.getUnusedAppRestrictionsStatus(context).get(2, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Exception) { 0 } }
    if (st == androidx.core.content.UnusedAppRestrictionsConstants.API_31) {
        BannerRow("Android may pause this app when unused", "Settings") {
            context.startActivity(IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName))
        }
    }
    val am = context.getSystemService(android.app.ActivityManager::class.java)
    if (am.isBackgroundRestricted) BannerRow("Battery setting Restricted delays messages", "Settings") {
        context.startActivity(Intent(SysSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)))
    }
}

@Composable
private fun BannerRow(text: String, action: String, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(Modifier.padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(text, Modifier.weight(1f))
            TextButton(onClick = onClick) { Text(action) }
        }
    }
}

@Composable
private fun PeerRow(vm: AppViewModel, p: Peer, row: PairingRow?, now: Long, highlighted: Boolean, onRemove: () -> Unit) {
    val x = label(p)
    var detail by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp).then(if (highlighted) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(x + if (p.missing) " (missing)" else "", style = MaterialTheme.typography.titleMedium,
                color = if (p.missing || !p.reachable) Color.Gray else Color.Unspecified,
                modifier = Modifier.clickable { if (p.missing || !p.reachable) vm.tapGreyed() else detail = !detail })
            Text(AppEffects.platformLabel(p.platform) + (if (!p.reachable) ", unreachable" else "") + (if (p.paused) ", signed out" else ""), color = Color.Gray)
            p.note?.let { Text(it) }
            when {
                row != null -> PairingRowView(vm, p, row, now)
                !p.pinned -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.pair(p.id) }) { Text("Pair") }
                    OutlinedButton(onClick = { vm.deny(p.id) }) { Text("Deny") }
                }
                p.notPairedOnPeer -> {
                    Text(if (p.listDeniesMe) "Declined by $x" else "Not paired on $x")
                    OutlinedButton(onClick = { vm.cancelPairing(p.id) }) { Text("Cancel pairing") }
                }
                p.waiting -> WaitingView(vm, p, x, now)
                p.missing -> OutlinedButton(onClick = { vm.localDelete(p.id) }) { Text("Delete") }
                p.declined -> Text("Declined by $x")
            }
            if (p.pinned && row == null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onRemove) { Text("Remove") }
                TextButton(onClick = { vm.setHidden(p.id, !p.hidden) }) { Text(if (p.hidden) "Unhide" else "Hide") }
            } else if (row == null && p.pinned.not()) TextButton(onClick = onRemove) { Text("Remove") }
            if (detail && p.pinned) PeerDetail(vm, p)
        }
    }
}

@Composable
private fun WaitingView(vm: AppViewModel, p: Peer, x: String, now: Long) {
    Text("Waiting for $x: open PushArmor there and approve")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { vm.cancelPairing(p.id) }) { Text("Cancel pairing") }
        val r = p.lastApproveResult
        if (r != null && r != "sent" && r != "stored" && r != "denied") {
            Button(onClick = { vm.approve(p.id) }, enabled = now - p.lastSendAt >= 60_000) { Text("Send again") }
        }
    }
}

@Composable
private fun PairingRowView(vm: AppViewModel, p: Peer, row: PairingRow, now: Long) {
    val x = label(p)
    Text("Times out in " + Countdown.format(row.startedAt, now), color = Color.Gray)
    when {
        row.state == PairState.SHOWN && p.waiting -> WaitingView(vm, p, x, now)
        row.state == PairState.SHOWN -> {
            Text("Pairing fingerprint ${row.fingerprint}", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.approve(p.id) }) { Text("Approve") }
                OutlinedButton(onClick = { vm.deny(p.id) }) { Text("Deny") }
            }
        }
        row.role == PairRole.X && row.state == PairState.PROMPTED -> {
            Text("A new peer wants to pair.")
            Button(onClick = { vm.reply(p.id) }) { Text("Reply") }
        }
        row.role == PairRole.X -> Text("Replied. Waiting for $x.")
        else -> {
            Text("Waiting for $x to reply.")
            when (PairingEngine.hint(row, p, now)) {
                PairDecide.Hint.STILL_HOLDS -> Text("$x still holds an earlier pairing. On $x, tap Cancel pairing, then tap Send again.")
                PairDecide.Hint.NO_REPLY_YET -> Text("No reply yet. Open PushArmor on $x, or tap Send again.")
                null -> Unit
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (row.role == PairRole.N && row.state != PairState.PROMPTED && !(row.state == PairState.SHOWN && p.approveVerified)) {
            Button(onClick = { vm.sendAgainPair(p.id) }, enabled = now - row.lastSendAt >= PairingEngine.SEND_AGAIN_MS) { Text("Send again") }
        }
        OutlinedButton(onClick = { vm.cancelPairing(p.id) }) { Text("Cancel pairing") }
    }
}

/** Per-peer switches; greyed while the main switch is off. */
@Composable
private fun PeerDetail(vm: AppViewModel, p: Peer) {
    val ents by vm.peerEntities.collectAsState()
    val e = ents.firstOrNull { it.id == p.id } ?: return
    val s = vm.g.settings
    SwitchRow("Show message content on lock screen", e.lockScreen, Policy.peerSwitchEnabled(s.lockScreen)) { vm.setPeerSwitch(p.id, lock = it) }
    SwitchRow("Send messages to watch", e.watch, Policy.peerSwitchEnabled(s.watch)) { vm.setPeerSwitch(p.id, watch = it) }
    SwitchRow("Always hide content", e.hideContent, true) { vm.setPeerSwitch(p.id, hide = it) }
}

@Composable
fun SwitchRow(text: String, checked: Boolean, enabled: Boolean = true, sub: String? = null, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f)) {
            Text(text, color = if (enabled) Color.Unspecified else Color.Gray)
            sub?.let { Text(it, color = Color.Gray, style = MaterialTheme.typography.bodySmall) }
        }
        Switch(checked, onChange, enabled = enabled)
    }
}

/** Send: compose field with "(N / 2048)", type chip + "Send as text", recipient picker, result. */
@Composable
fun SendScreen(vm: AppViewModel, initial: String = "", preselect: String? = null, onSent: (String) -> Unit = {}) {
    var text by remember { mutableStateOf(initial) }
    var asText by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    val peers by vm.peers.collectAsState()
    val me by vm.self.collectAsState()
    val all = vm.allPeers()
    val picked = remember { mutableStateListOf<String>().apply { preselect?.let { add(it) } } }
    val scope = rememberCoroutineScope()
    val bytes = SizeCap.utf8Size(text)
    val showAll = vm.g.settings.showAll
    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth(), minLines = 3, label = { Text("Message") })
        Text(if (bytes > SizeCap.MAX_CONTENT_BYTES) "Too long ($bytes / 2048)" else "($bytes / 2048)",
            color = if (SizeCap.isNearCap(text)) Color.Red else Color.Gray)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = true, onClick = {}, label = { Text(if (asText) "text" else Detect.type(text).key) })
            FilterChip(selected = asText, onClick = { asText = !asText }, label = { Text("Send as text") })
        }
        if (showAll && all.size > 1) Row {
            Checkbox(picked.containsAll(all.map { it.id }), { on -> picked.clear(); if (on) picked.addAll(all.map { it.id }) })
            Text("All")
        }
        val selfId = me?.id
        for (p in peers.filter { it.pinned && it.id != selfId }) {
            val ok = p.inAll
            Row {
                Checkbox(p.id in picked, { if (it) picked.add(p.id) else picked.remove(p.id) }, enabled = ok)
                Text(label(p), color = if (ok) Color.Unspecified else Color.Gray)
            }
        }
        Button(onClick = {
            scope.launch { val r = vm.send(picked.toList(), text, asText); result = r; onSent(r) }
        }, enabled = picked.isNotEmpty() && text.isNotEmpty() && bytes <= SizeCap.MAX_CONTENT_BYTES) { Text("Send") }
        result?.let { Text(it) }
    }
}

/** History: newest first, unread dot, sent/received filters plus peer chips (catalog History filter). */
@Composable
fun HistoryScreen(vm: AppViewModel, onPeer: (String) -> Unit) {
    val rows by vm.history.collectAsState()
    val peers by vm.peers.collectAsState()
    var chip by remember { mutableStateOf<HistoryFilter.Chip>(HistoryFilter.Chip.All) }
    var dir by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<Long?>(null) }
    val context = LocalContext.current
    fun nameOf(id: String) = peers.firstOrNull { it.id == id }?.let { (it.name ?: label(it)) + if (it.removed) " (removed)" else "" } ?: "(removed)"
    val frows = rows.map { HistoryFilter.Row(it.peerId, it.direction == "RECEIVED") }
    val eff = HistoryFilter.effective(frows, chip)
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (c in HistoryFilter.chips(frows, ::nameOf)) {
                val t = when (c) { HistoryFilter.Chip.All -> "All"; HistoryFilter.Chip.Unknown -> "Unknown"; is HistoryFilter.Chip.PeerChip -> c.name }
                FilterChip(selected = eff == c, onClick = { chip = c }, label = { Text(t) })
            }
            FilterChip(selected = dir == "SENT", onClick = { dir = if (dir == "SENT") null else "SENT" }, label = { Text("Sent") })
            FilterChip(selected = dir == "RECEIVED", onClick = { dir = if (dir == "RECEIVED") null else "RECEIVED" }, label = { Text("Received") })
        }
        LazyColumn {
            items(rows.filter { HistoryFilter.matches(HistoryFilter.Row(it.peerId, it.direction == "RECEIVED"), eff) && (dir == null || it.direction == dir) }, key = { it.id }) { h ->
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).clickable { open = h.id; vm.markRead(h.id) }) {
                    val who = h.peerId?.let { nameOf(it) } ?: if (h.direction == "SENT") "Sent" else "Unknown sender"
                    Text((if (!h.read && h.type in setOf("url", "text", "tel")) "* " else "") + who, color = Color.Gray,
                        modifier = Modifier.clickable(enabled = h.peerId != null) { h.peerId?.let(onPeer) })
                    val body = when (h.type) {
                        "unreadable" -> "PushArmor received a message it could not read" + if (h.count > 1) " (${h.count})" else ""
                        "invalid" -> "Invalid message received" + if (h.count > 1) " (${h.count})" else ""
                        "denied" -> "Denied this device"
                        "paused" -> "Paused receiving"
                        "resumed" -> "Resumed receiving"
                        else -> h.content.orEmpty()
                    }
                    Text(body, maxLines = if (open == h.id) Int.MAX_VALUE else 3)
                    val hc = h.content
                    if (open == h.id && hc != null) {
                        SelectionContainer { Text(hc) }
                        Row {
                            TextButton(onClick = { com.pusharmor.app.notify.ActionActivity.copy(context, hc) }) { Text("Copy") }
                            TextButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, hc), null)) }) { Text("Share") }
                            if (h.type == "url") com.pusharmor.protocol.UrlCheck.parse(hc)?.let { u ->
                                TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u.href)).addCategory(Intent.CATEGORY_BROWSABLE)) }) { Text("Open") }
                            }
                            if (h.type == "tel" && com.pusharmor.protocol.Phone.isPhone(hc)) {
                                TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(hc)))) }) { Text("Dial") }
                            }
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

/** Settings (section 8). */
@Composable
fun SettingsScreen(vm: AppViewModel, onDeleteAccount: () -> Unit, onSignedOut: () -> Unit) {
    val prefs by vm.prefs.collectAsState()
    val context = LocalContext.current
    val me by vm.self.collectAsState()
    // null until the user types: shows the self name as it loads, and a later self update keeps typed text.
    var typed by remember { mutableStateOf<String?>(null) }
    val name = typed ?: me?.name ?: ""
    var confirmHistory by remember { mutableStateOf(false) }
    fun b(k: androidx.datastore.preferences.core.Preferences.Key<Boolean>, d: Boolean) = prefs?.get(k) ?: d
    Column(Modifier.fillMaxSize().padding(12.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row {
            OutlinedTextField(name, { typed = it.take(32) }, label = { Text("Peer name") }, singleLine = true, modifier = Modifier.weight(1f))
            TextButton(onClick = { vm.rename(name) }) { Text("Save") }
        }
        SwitchRow("Show \"All\" option", b(Settings.K.SHOW_ALL, true)) { vm.setPref(Settings.K.SHOW_ALL, it) }
        SwitchRow("Tap opens link", b(Settings.K.TAP_OPENS_LINK, true)) { vm.setPref(Settings.K.TAP_OPENS_LINK, it) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("History days")
            for (d in listOf(1, 7, 30, 90, 365)) FilterChip(selected = (prefs?.get(Settings.K.HISTORY_DAYS) ?: 30) == d,
                onClick = { vm.setPref(Settings.K.HISTORY_DAYS, d) }, label = { Text("$d") })
        }
        TextButton(onClick = { confirmHistory = true }) { Text("Delete all history") }
        SwitchRow("Direct share targets", b(Settings.K.DIRECT_SHARE, true)) { vm.setPref(Settings.K.DIRECT_SHARE, it) }
        if (vm.g.push.hasPlayServices) {
            val up = prefs?.get(Settings.K.PUSH_TYPE) == "unifiedpush"
            Text("Push method")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = !up, onClick = { if (up) vm.switchPush(false) }, label = { Text("Google (default)") })
                FilterChip(selected = up, onClick = { if (!up) vm.switchPush(true) }, label = { Text("UnifiedPush app") })
            }
            if (up && UnifiedPushSupport.distributors(context).size > 1) for (d in UnifiedPushSupport.distributors(context)) {
                TextButton(onClick = { UnifiedPushSupport.pick(vm.g, d) }) { Text(d) }
            }
        }
        TextButton(onClick = {
            context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
        }) { Text("Notifications") }
        SwitchRow("Show message content on lock screen", b(Settings.K.LOCK_SCREEN, true), sub = "When off, the lock screen shows 'New message' only") { vm.setPref(Settings.K.LOCK_SCREEN, it) }
        TextButton(onClick = { try { context.startActivity(Intent("android.settings.NOTIFICATION_SETTINGS")) } catch (e: Exception) { } }) { Text("System lock screen setting") }
        SwitchRow("Send messages to watch", b(Settings.K.WATCH, true), sub = "When off, the watch gets no notice at all") { vm.setPref(Settings.K.WATCH, it) }
        SwitchRow("Always hide content", b(Settings.K.HIDE_CONTENT, false)) { vm.setPref(Settings.K.HIDE_CONTENT, it) }
        me?.email?.let {
            Text("Signed in as $it")
            if (it.endsWith("@privaterelay.appleid.com")) Text("iOS Settings > Apple ID > Sign in with Apple, and appleid.apple.com > Hide My Email, list the address to use on another peer.", color = Color.Gray)
        }
        Button(onClick = { vm.signOut(onSignedOut) }) { Text("Sign out") }
        OutlinedButton(onClick = onDeleteAccount) { Text("Delete account") }
        vm.message.collectAsState().value?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
    if (confirmHistory) AlertDialog(onDismissRequest = { confirmHistory = false }, text = { Text("Delete all history?") },
        confirmButton = { TextButton(onClick = { vm.deleteAllHistory(); confirmHistory = false }) { Text("Delete") } },
        dismissButton = { TextButton(onClick = { confirmHistory = false }) { Text("Cancel") } })
}
