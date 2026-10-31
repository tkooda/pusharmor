package com.pusharmor.app.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings as SysSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.toMutableStateList
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.PackageManagerCompat
import androidx.core.content.IntentCompat
import com.pusharmor.app.BuildConfig
import com.pusharmor.app.R
import com.pusharmor.app.ScreenshotMode
import com.pusharmor.app.data.Settings
import com.pusharmor.app.notify.AppEffects
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.notify.Policy
import com.pusharmor.app.push.UnifiedPushSupport
import com.pusharmor.app.ui.theme.EmptyState
import com.pusharmor.app.ui.theme.FingerprintText
import com.pusharmor.app.ui.theme.GreenButton
import com.pusharmor.app.ui.theme.GroupedList
import com.pusharmor.app.ui.theme.IconTile
import com.pusharmor.app.ui.theme.LocalPaExtra
import com.pusharmor.app.ui.theme.MessagesIllustration
import com.pusharmor.app.ui.theme.MiddleEllipsisText
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.app.ui.theme.PaTopBar
import com.pusharmor.app.ui.theme.SectionHeader
import com.pusharmor.app.ui.theme.ThemePref
import com.pusharmor.app.ui.theme.StatusLine
import com.pusharmor.app.ui.theme.groupItem
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Countdown
import com.pusharmor.protocol.Detect
import com.pusharmor.protocol.PairDecide
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.SizeCap
import com.pusharmor.protocol.engine.PairingEngine
import com.pusharmor.protocol.engine.PairingRow
import com.pusharmor.store.toRow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.update
import java.text.DateFormat
import java.util.Date

internal fun label(p: Peer) = p.name ?: "${AppEffects.platformLabel(p.platform)} device added ${AppEffects.dateLabel(p.created)}"

/** Peers other than self; none until self is known, so the own device never shows as a peer. */
internal fun others(peers: List<Peer>, selfId: String?): List<Peer> = if (selfId == null) emptyList() else peers.filter { it.id != selfId }

internal fun platformIcon(platform: String): ImageVector = when (platform) {
    "chrome" -> PaIcons.Laptop
    "cli" -> PaIcons.Terminal
    "firefox" -> PaIcons.Desktop
    "android", "ios" -> PaIcons.Smartphone
    else -> PaIcons.Devices
}

/** Send scrolls when the area above Send cannot hold the chips, the caption rows, and a field of [fieldMinPx]. */
internal fun sendScrolls(areaPx: Int, chipsPx: Int, extrasPx: Int, fieldMinPx: Int): Boolean =
    areaPx > 0 && areaPx < chipsPx + extrasPx + fieldMinPx

/** Scroll the Peers list to the top when a pairing card is added, unless a highlight scroll is still due. */
internal fun pairingScrollTop(before: Int, after: Int, aiming: Boolean): Boolean = !aiming && after > before

/** Peers screen (section 8): banners, pairing cards, This device, the peer group. */
@Composable
fun PeersScreen(vm: AppViewModel) {
    val peers by vm.peers.collectAsState()
    val rows by vm.pairings.collectAsState()
    val highlight by vm.highlight.collectAsState()
    val prefs by vm.prefs.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    // Saved, so both dialogs stay open through a rotation (I523); the device by its id.
    var confirmRemove by rememberSaveable { mutableStateOf<String?>(null) }
    var pairHowTo by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        vm.onPeersOpen()
        while (true) { delay(30_000); now = System.currentTimeMillis(); vm.onPeersOpen() } // timeout timer while open
    }
    val me by vm.self.collectAsState()
    // No paired device: the first-pair steps and the Waiting to pair row (I612; was a screen in place of the tabs, Q338).
    val firstDevice = me != null && UiText.noPairedDevice(others(peers, me?.id))
    val list = others(peers, me?.id).filter { !(it.removed && !it.pinned && rows.none { r -> r.peerId == it.id }) }
    val pairing = list.filter { p -> rows.any { it.peerId == p.id } }
    val plain = list.filter { p -> rows.none { it.peerId == p.id } }
    val lastRefresh = prefs?.get(Settings.K.LAST_REFRESH) ?: 0
    val canRefresh = now - lastRefresh >= 60_000
    val state = rememberLazyListState()
    // The highlight scrolls once per visit; leaving the screen clears it.
    var aimed by remember { mutableStateOf<String?>(null) }
    DisposableEffect(Unit) { onDispose { vm.highlight.value = null } }
    // Item order: banners, [steps], [pairing header, cards], [peers header, peers].
    LaunchedEffect(highlight, list.size) {
        highlight?.takeIf { it != aimed }?.let { h ->
            val pi = pairing.indexOfFirst { it.id == h }
            val st = if (firstDevice) 1 else 0
            val base = if (pairing.isEmpty()) 1 + st else 2 + st + pairing.size
            val idx = if (pi >= 0) 2 + st + pi else plain.indexOfFirst { it.id == h }.takeIf { it >= 0 }?.let { base + 1 + it }
            idx?.let { state.animateScrollToItem(it); aimed = h }
        }
    }
    // A pairing card that appears goes in at the top; show it rather than keep the old anchor.
    var shownPairing by remember { mutableIntStateOf(pairing.size) }
    LaunchedEffect(pairing.size) {
        if (pairingScrollTop(shownPairing, pairing.size, aiming = highlight != null && highlight != aimed)) state.scrollToItem(0)
        shownPairing = pairing.size
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            PaTopBar("Devices", actions = {
                IconButton(onClick = { vm.refresh() }, enabled = canRefresh) { Icon(PaIcons.Refresh, "Refresh") }
            })
            LazyColumn(Modifier.weight(1f), state = state, contentPadding = PaddingValues(bottom = 16.dp)) {
                item(key = "banners") {
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Banners(vm, prefs?.get(Settings.K.BANNER))
                    }
                }
                if (firstDevice) item(key = "steps") {
                    Column { SectionHeader(UiText.FIRST_DEVICE_TITLE); FirstDeviceSteps() }
                }
                if (pairing.isNotEmpty()) {
                    item(key = "pairing-header") { SectionHeader("Pairing") }
                    itemsIndexed(pairing, key = { _, p -> "pair-" + p.id }) { i, p ->
                        val row = rows.first { it.peerId == p.id }
                        PairingCard(vm, p, row, now, Modifier.padding(top = if (i > 0) 12.dp else 0.dp))
                    }
                }
                if (plain.isNotEmpty()) {
                    item(key = "peers-header") { SectionHeader(if (firstDevice) "Waiting to pair" else "Other devices") }
                    itemsIndexed(plain, key = { _, p -> p.id }) { i, p ->
                        PeerRow(vm, p, now, p.id == highlight, Modifier.padding(top = if (i > 0) 2.dp else 0.dp).groupItem(i, plain.size)) { confirmRemove = p.id }
                    }
                } else if (pairing.isEmpty() && firstDevice) {
                    item(key = "waiting-header") { SectionHeader("Waiting to pair") }
                    item(key = "waiting") {
                        ListItem(modifier = Modifier.padding(horizontal = 16.dp), colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            leadingContent = { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 3.dp) },
                            headlineContent = { Text(UiText.FIRST_DEVICE_WAITING, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) })
                    }
                }
                if (!firstDevice && (plain.isNotEmpty() || pairing.isNotEmpty())) item(key = "pair-new") {
                    OutlinedButton(onClick = { pairHowTo = true }, Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp).fillMaxWidth().heightIn(min = 48.dp)) {
                        Text("Pair a new device")
                    }
                }
            }
        }
    }
    peers.firstOrNull { it.id == confirmRemove }?.let { p ->
        val x = label(p)
        AlertDialog(onDismissRequest = { confirmRemove = null },
            text = { Text("Remove $x from this account? $x must log in again and pair with every device again.") },
            confirmButton = { TextButton(onClick = { vm.remove(p.id); confirmRemove = null }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text("Cancel") } })
    }
    if (pairHowTo) AlertDialog(onDismissRequest = { pairHowTo = false }, title = { Text("Pair a new device") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                UiText.numbered(UiText.PAIR_HOWTO_STEPS).forEach { Text(it, style = MaterialTheme.typography.bodyLarge) }
            }
        },
        confirmButton = { TextButton(onClick = { pairHowTo = false }) { Text("OK") } })
}

/** First-device steps (I607): one card, a filled numbered circle per step, dividers between the steps, as on iOS. */
@Composable
internal fun FirstDeviceSteps(modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val ex = LocalPaExtra.current
    Card(modifier.padding(horizontal = 16.dp).fillMaxWidth(), shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = ex.tile), border = androidx.compose.foundation.BorderStroke(1.dp, ex.cardEdge)) {
        UiText.FIRST_DEVICE_STEPS.forEachIndexed { i, t ->
            if (i > 0) HorizontalDivider(Modifier.padding(start = 56.dp), color = cs.outlineVariant)
            ListItem(colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                leadingContent = {
                    Box(Modifier.size(28.dp).clip(CircleShape).background(cs.primary), Alignment.Center) {
                        Text("${i + 1}", color = cs.onPrimary, style = MaterialTheme.typography.labelLarge)
                    }
                },
                headlineContent = { Text(t, style = MaterialTheme.typography.bodyLarge) })
        }
    }
}

/**
 * This device's name, renamed in place (I601): the pencil turns the name into a field with its text selected,
 * Cancel and Save beside it. Done saves, Back cancels; an invalid name shows why and Save is greyed.
 */
@Composable
internal fun NameEditRow(current: String, modifier: Modifier = Modifier, onSave: (String) -> Unit) {
    val st = rememberSaveable(saver = NameEdit.Saver) { NameEdit() }
    val cs = MaterialTheme.colorScheme
    if (!st.editing) {
        SettingRow("Device name", current, modifier, trailing = { Icon(PaIcons.Edit, null, tint = cs.onSurfaceVariant) }) { st.start(current) }
        return
    }
    val error = st.error
    val focus = remember { FocusRequester() }
    fun save() { st.save()?.let(onSave) }
    androidx.activity.compose.BackHandler { st.cancel() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Row(modifier.padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.Top) {
        OutlinedTextField(st.typed, { st.typed = it }, Modifier.weight(1f).focusRequester(focus), label = { Text("Device name") }, singleLine = true,
            isError = error != null, supportingText = error?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }))
        IconButton(onClick = { st.cancel() }, Modifier.padding(top = 4.dp)) { Icon(PaIcons.Close, "Cancel") }
        IconButton(onClick = { save() }, Modifier.padding(top = 4.dp), enabled = error == null) { Icon(PaIcons.Check, "Save name") }
    }
}

/** In-place rename state (I601): Start selects the name, Cancel drops the edit, Save returns the name only when it is valid. */
internal class NameEdit(editing: Boolean = false, typed: TextFieldValue = TextFieldValue()) {
    var editing by mutableStateOf(editing)
    var typed by mutableStateOf(typed)
    /** Empty, too long, or not plain ASCII: the reason, shown under the field; Save is greyed. */
    val error: String? get() = UiText.nameError(typed.text)
    fun start(current: String) { typed = TextFieldValue(current, TextRange(0, current.length)); editing = true }
    fun cancel() { editing = false }
    fun save(): String? = typed.text.takeIf { error == null }?.also { editing = false }

    companion object {
        /** Kept through a rotation (I523). */
        val Saver = listSaver<NameEdit, Any>(
            save = { listOf(it.editing, it.typed.text, it.typed.selection.start, it.typed.selection.end) },
            restore = { NameEdit(it[0] as Boolean, TextFieldValue(it[1] as String, TextRange(it[2] as Int, it[3] as Int))) })
    }
}

@Composable
private fun Banners(vm: AppViewModel, banner: String?) {
    val context = LocalContext.current
    // Read here, so every check below runs again on each return to the app (I479).
    val tick = resumeTick()
    val n = vm.g.notifier
    if (!n.enabled() || n.mainChannelsBlocked()) BannerRow("Notifications are off. Messages will not be shown.", "Fix", fault = true, PaIcons.NotificationsOff) {
        context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
    }
    n.blockedChannelPeer(vm.peerEntities.collectAsState().value)?.let { BannerRow("Messages from $it are blocked.", "Fix", fault = true, PaIcons.NotificationsOff) {
        context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
    } }
    if (banner?.startsWith("no_distributor") == true) {
        BannerRow("Install a UnifiedPush app (we suggest ntfy).", "Get", fault = false, PaIcons.Info) {
            val url = if (vm.g.push.hasPlayServices) "https://play.google.com/store/apps/details?id=io.heckel.ntfy" else "https://f-droid.org/packages/io.heckel.ntfy/"
            startOrToast(context, Intent(Intent.ACTION_VIEW, Uri.parse(url))) { vm.message.value = it }
        }
        if (vm.g.push.hasPlayServices) TextButton(onClick = { vm.switchPush(toUp = false) }) { Text("Switch back to Google") }
    }
    val s = vm.g.settings
    val upAt = s.get(Settings.K.UP_REGISTERED_AT)
    if (s.get(Settings.K.PUSH_TYPE) == "unifiedpush" && upAt != null && !s.flag(Settings.K.UP_VERIFIED, false) && System.currentTimeMillis() - upAt > 10 * 60_000) {
        BannerRow("This push server did not deliver. Check your UnifiedPush app.", "Retry", fault = true, PaIcons.Info) { vm.retryPush() }
        if (vm.g.push.hasPlayServices) TextButton(onClick = { vm.switchPush(toUp = false) }) { Text("Switch back to Google") }
    }
    val st = remember(tick) { try { PackageManagerCompat.getUnusedAppRestrictionsStatus(context).get(2, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Exception) { 0 } }
    if (st == androidx.core.content.UnusedAppRestrictionsConstants.API_31) {
        BannerRow(UiText.HIBERNATION_BANNER, "Settings", fault = false, PaIcons.Info) {
            context.startActivity(IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName))
        }
    }
    val am = context.getSystemService(android.app.ActivityManager::class.java)
    if (am.isBackgroundRestricted) BannerRow("Battery setting Restricted delays messages.", "Settings", fault = false, PaIcons.Info) {
        context.startActivity(Intent(SysSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)))
    }
}

/** Fault banners on errorContainer, advice on surfaceContainerHigh. */
@Composable
private fun BannerRow(text: String, action: String, fault: Boolean, icon: ImageVector, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = if (fault) cs.errorContainer else cs.surfaceContainerHigh,
            contentColor = if (fault) cs.onErrorContainer else cs.onSurface)) {
        Column(Modifier.padding(start = 16.dp, top = 16.dp, end = 8.dp, bottom = 8.dp)) {
            Row(Modifier.padding(end = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Icon(icon, null)
                Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onClick, colors = ButtonDefaults.textButtonColors(
                    contentColor = if (fault) cs.onErrorContainer else cs.primary)) { Text(action) }
            }
        }
    }
}

/** One peer in the Peers group: icon tile, name, platform, status line, overflow menu; tap shows the switches. */
@Composable
private fun PeerRow(vm: AppViewModel, p: Peer, now: Long, highlighted: Boolean, modifier: Modifier, onRemove: () -> Unit) {
    val x = label(p)
    var detail by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val pairingAgain by vm.pairingAgain.collectAsState()
    val running by vm.running.collectAsState()
    val prefs by vm.prefs.collectAsState()
    val shareShown = prefs?.get(Settings.K.SHARE_OFF)?.contains(p.id) != true
    val grey = p.missing || !p.reachable
    val cs = MaterialTheme.colorScheme
    // Pairing and note lines replace the status line (catalog order).
    val stateText = when {
        !p.pinned -> null
        p.notPairedOnPeer -> if (p.listDeniesMe) "Declined by $x" else "Not paired on $x"
        p.waiting -> "Waiting for $x: open PushArmor there and approve."
        p.missing -> null
        p.declined -> "Declined by $x"
        else -> null
    }
    val lines = listOfNotNull(p.note, stateText)
    Column(modifier.then(if (highlighted) Modifier.background(cs.secondaryContainer) else Modifier)) {
        ListItem(
            modifier = Modifier.clickable(role = Role.Button) { if (grey) vm.tapGreyed() else detail = !detail }
                .semantics { if (!grey) stateDescription = if (detail) "Expanded" else "Collapsed" },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            leadingContent = { IconTile(platformIcon(p.platform), dim = grey) },
            headlineContent = {
                Text(x, Modifier.alpha(if (grey) 0.6f else 1f), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            },
            supportingContent = {
                Column {
                    Text(AppEffects.platformLabel(p.platform))
                    if (lines.isEmpty()) { val (k, w) = UiText.status(p); StatusLine(k, w) } else for (l in lines) Text(l)
                }
            },
            trailingContent = {
                Box {
                    IconButton(onClick = { menu = true }) { Icon(PaIcons.MoreVert, "More options for $x") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; onRemove() })
                        if (p.pinned) DropdownMenuItem(text = { Text(if (p.hidden) "Unhide" else "Hide") }, onClick = { menu = false; vm.setHidden(p.id, !p.hidden) })
                        // Per device, on by default (I598); the tick is the state, so the row reads as a checkbox.
                        if (p.pinned) DropdownMenuItem(text = { Text("Show in share sheet") }, onClick = { menu = false; vm.setShareShown(p.id, !shareShown) },
                            modifier = Modifier.semantics { stateDescription = if (shareShown) "On" else "Off" },
                            trailingIcon = { Checkbox(shareShown, null) })
                        if (p.missing) DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; vm.localDelete(p.id) })
                        if (p.offersPairAgain) DropdownMenuItem(text = { Text("Cancel pairing") }, onClick = { menu = false; vm.cancelPairing(p.id) })
                    }
                }
            },
        )
        val inset = Modifier.padding(start = 72.dp, end = 16.dp)
        when {
            !p.pinned -> Row(inset.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilledTonalButton(onClick = { vm.pair(p.id) }, Modifier.heightIn(min = 48.dp), enabled = "pair:${p.id}" !in running) { Text("Pair") }
                OutlinedButton(onClick = { vm.deny(p.id) }, Modifier.heightIn(min = 48.dp), enabled = "deny:${p.id}" !in running, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.error)) { Text("Deny") }
            }
            p.notPairedOnPeer -> Row(inset.padding(bottom = 8.dp)) {
                if (p.offersPairAgain) OutlinedButton(onClick = { vm.pairAgain(p.id) }, Modifier.heightIn(min = 48.dp), enabled = p.id !in pairingAgain) { Text("Pair again") }
                else OutlinedButton(onClick = { vm.cancelPairing(p.id) }, Modifier.heightIn(min = 48.dp)) { Text("Cancel pairing") }
            }
            p.waiting -> Row(inset.padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (p.offersPairAgain) OutlinedButton(onClick = { vm.pairAgain(p.id) }, Modifier.heightIn(min = 48.dp), enabled = p.id !in pairingAgain) { Text("Pair again") }
                else OutlinedButton(onClick = { vm.cancelPairing(p.id) }, Modifier.heightIn(min = 48.dp)) { Text("Cancel pairing") }
                WaitingSendAgain(vm, p, now)
            }
        }
        if (detail && p.pinned) Column(inset.padding(bottom = 8.dp)) { PeerDetail(vm, p) }
    }
}

/** "Send again" while waiting for the peer's approve, after a failed send. */
@Composable
private fun WaitingSendAgain(vm: AppViewModel, p: Peer, now: Long) {
    val r = p.lastApproveResult
    val running by vm.running.collectAsState()
    if (r != null && r != "sent" && r != "stored" && r != "denied") {
        TextButton(onClick = { vm.approve(p.id) }, enabled = now - p.lastSendAt >= 60_000 && "approve:${p.id}" !in running) { Text("Send again") }
    }
}

/** Pairing card: header, fingerprint plate with Deny / Approve, or the other pairing states; footer with Cancel pairing and the timeout. */
@Composable
private fun PairingCard(vm: AppViewModel, p: Peer, row: PairingRow, now: Long, modifier: Modifier) {
    val x = label(p)
    val ex = LocalPaExtra.current
    val cs = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(24.dp)
    val shown = row.state == PairState.SHOWN && !p.waiting
    val prompted = row.role == PairRole.X && row.state == PairState.PROMPTED
    val body = MaterialTheme.typography.bodyMedium
    val running by vm.running.collectAsState()
    Column(modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(shape).background(ex.tile).border(1.dp, ex.pairBorder, shape)
        // Bottom padding as wide as the gap above the footer, so Cancel pairing does not sit on the border (I605).
        .padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            IconTile(platformIcon(p.platform))
            Column {
                Text(if (shown || prompted) "Pair with new device: \"$x\"" else x, style = MaterialTheme.typography.titleMedium)
                Text(AppEffects.platformLabel(p.platform), style = body, color = cs.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(16.dp))
        when {
            row.state == PairState.SHOWN && p.waiting -> {
                Text("Waiting for $x: open PushArmor there and approve.", style = body, color = cs.onSurfaceVariant)
                WaitingSendAgain(vm, p, now)
            }
            row.state == PairState.SHOWN -> {
                FingerprintPlate(row.fingerprint.orEmpty(), x)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = { vm.deny(p.id) }, Modifier.weight(1f).heightIn(min = 48.dp), enabled = "deny:${p.id}" !in running,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = cs.error),
                        border = androidx.compose.foundation.BorderStroke(1.dp, cs.error)) { Text("Deny") }
                    GreenButton(onClick = { vm.approve(p.id) }, text = "Approve", icon = PaIcons.Check, modifier = Modifier.weight(1f),
                        enabled = "approve:${p.id}" !in running)
                }
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(PaIcons.Info, null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
                    Text("Codes do not match? Tap Deny.", style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
            }
            prompted -> {
                Text("A new device wants to pair.", style = body, color = cs.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                GreenButton(onClick = { vm.reply(p.id) }, text = "Reply", icon = null, modifier = Modifier.fillMaxWidth())
            }
            row.role == PairRole.X -> Text("Replied. Waiting for $x.", style = body, color = cs.onSurfaceVariant)
            else -> {
                Text("Waiting for $x to reply.", style = body, color = cs.onSurfaceVariant)
                when (PairingEngine.hint(row, p, now)) {
                    PairDecide.Hint.STILL_HOLDS -> Text("$x still holds an earlier pairing. On $x, tap Cancel pairing, then tap Send again.", style = body, color = cs.onSurfaceVariant)
                    PairDecide.Hint.NO_REPLY_YET -> Text("No reply yet. Open PushArmor on $x, or tap Send again.", style = body, color = cs.onSurfaceVariant)
                    null -> Unit
                }
            }
        }
        if (row.role == PairRole.N && row.state != PairState.PROMPTED && !(row.state == PairState.SHOWN && p.approveVerified)) {
            TextButton(onClick = { vm.sendAgainPair(p.id) }, enabled = now - row.lastSendAt >= PairingEngine.SEND_AGAIN_MS) { Text("Send again") }
        }
        Spacer(Modifier.height(12.dp))
        // Divider across the full card width (out through the 16 dp side padding).
        HorizontalDivider(Modifier.layout { m, c ->
            val extra = 32.dp.roundToPx()
            val pl = m.measure(c.copy(minWidth = c.maxWidth + extra, maxWidth = c.maxWidth + extra))
            layout(c.maxWidth, pl.height) { pl.place(-extra / 2, 0) }
        }, color = cs.outlineVariant)
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { vm.cancelPairing(p.id) }, Modifier.heightIn(min = 48.dp)) { Text("Cancel pairing") }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(PaIcons.Schedule, null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
                Text("Times out in " + Countdown.format(row.startedAt, now), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
        }
    }
}

/** Plate with the caps label and four mono cells; read as one element, character by character. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FingerprintPlate(code: String, x: String) {
    val ex = LocalPaExtra.current
    val cs = MaterialTheme.colorScheme
    val wrap = LocalDensity.current.fontScale >= 1.5f
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(ex.plate).padding(horizontal = 12.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.clearAndSetSemantics {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_notify), null, Modifier.size(13.dp), tint = cs.primary)
            Text("Pairing fingerprint".uppercase(), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        val shape = RoundedCornerShape(14.dp)
        val cell: @Composable (Char, Modifier) -> Unit = { c, m ->
            Box(m.heightIn(min = 76.dp).clip(shape).background(ex.fpCell).border(1.dp, cs.outline, shape), Alignment.Center) {
                Text(c.toString(), style = FingerprintText, color = cs.onSurface) // one ink for every cell
            }
        }
        val sem = Modifier.clearAndSetSemantics { contentDescription = UiText.fingerprintLabel(code) }
        if (wrap) FlowRow(sem, horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(10.dp), maxItemsInEachRow = 2) {
            for (c in code) cell(c, Modifier.sizeIn(minWidth = 64.dp))
        } else Row(sem.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)) {
            for (c in code) cell(c, Modifier.weight(1f, fill = false).widthIn(max = 64.dp).fillMaxWidth())
        }
        Spacer(Modifier.height(12.dp))
        Text("Verify that \"$x\" shows this same code.", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

/** Per-peer switches; greyed while the main switch is off. */
@Composable
private fun PeerDetail(vm: AppViewModel, p: Peer) {
    val ents by vm.peerEntities.collectAsState()
    val e = ents.firstOrNull { it.id == p.id } ?: return
    val s = vm.g.settings
    SwitchRow("Show message content on lock screen", e.lockScreen, Policy.peerLockEnabled(s.showContent, s.lockScreen)) { vm.setPeerSwitch(p.id, lock = it) }
    SwitchRow("Send messages to watch", e.watch, Policy.peerSwitchEnabled(s.watch)) { vm.setPeerSwitch(p.id, watch = it) }
    SwitchRow("Always hide content", e.hideContent, true) { vm.setPeerSwitch(p.id, hide = it) }
}

/** A switch row; the whole row is the toggle target. */
@Composable
fun SwitchRow(text: String, checked: Boolean, enabled: Boolean = true, sub: String? = null, modifier: Modifier = Modifier, onChange: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
        .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(text, style = MaterialTheme.typography.bodyLarge, color = if (enabled) cs.onSurface else cs.onSurface.copy(alpha = 0.38f))
            sub?.let { Text(it, color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
        }
        Switch(checked, null, enabled = enabled)
    }
}

private val Modifier.rowPad get() = this.padding(horizontal = 16.dp)

/** Send: field, type caption and counter, "Send as text", device chips, green Send pinned at the bottom (above the keyboard). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SendScreen(vm: AppViewModel, initial: String = "", preselect: String? = null, title: String? = null, onPair: () -> Unit = {}, onSent: (String) -> Unit = {}) {
    val shots = BuildConfig.SCREENSHOT_MODE && ScreenshotMode.on && title != null
    var text by rememberSaveable { mutableStateOf(if (shots) ScreenshotMode.sendText else initial) }
    var asText by rememberSaveable { mutableStateOf(false) }
    // Count with the text, so a repeat of the same result still shows a snackbar.
    var result by remember { mutableStateOf<Pair<Int, String>?>(null) }
    val peers by vm.peers.collectAsState()
    val me by vm.self.collectAsState()
    val all = vm.allPeers()
    // Saved, so the chosen devices stay chosen through a rotation (I523).
    val picked = rememberSaveable(saver = listSaver({ it.toList() }, { it.toMutableStateList() })) {
        mutableStateListOf<String>().apply { preselect?.let { add(it) }; if (shots) addAll(ScreenshotMode.sendTo) }
    }
    // Last selection (local only): applied once the device list has loaded, unless a preselect or the screenshot data already chose.
    // With exactly one device that can receive, it is preselected.
    val canReceive = others(peers, me?.id).filter { it.inAll }.map { it.id }
    var restored by rememberSaveable { mutableStateOf(shots || picked.isNotEmpty()) }
    // Only devices that can receive now are sent to and counted: a chosen device that turns logged out,
    // unapproved or leaves All drops out, and so does a preselect that cannot receive.
    val sendTo = UiText.sendable(picked, canReceive)
    LaunchedEffect(canReceive) {
        if (!restored && canReceive.isNotEmpty()) {
            restored = true
            // Suspends, never blocks the main thread (I434). A chip tapped meanwhile is not added twice.
            val last = vm.g.settings.lastSendTo()
            picked.addAll(UiText.rememberedSelection(last, canReceive).filter { it !in picked })
            if (picked.isEmpty() && canReceive.size == 1) picked.add(canReceive[0])
        }
    }
    val scope = rememberCoroutineScope()
    val bytes = SizeCap.utf8Size(text)
    val prefs by vm.prefs.collectAsState()
    // Hidden until the settings load, so the chip does not flash on for a user who turned it off.
    val showAll = prefs?.get(Settings.K.SHOW_ALL) ?: (prefs != null)
    val ex = LocalPaExtra.current
    val cs = MaterialTheme.colorScheme
    // The app's one snackbar (I603); the share sheet has none, so it keeps its own.
    val shared = LocalSnackbar.current
    val snack = shared ?: remember { SnackbarHostState() }
    LaunchedEffect(result) { result?.let { snack.showSnackbar(it.second) } }
    // A result about the last send goes away once the message or the chosen devices change (I572).
    DismissSnackbarOnChange(snack, text to picked.toList())
    val detected = Detect.type(text)
    val type = if (asText) ContentType.TEXT else detected
    val keyboardUp = WindowInsets.isImeVisible
    // With the keyboard up the field keeps at least 2 lines: the caption and "Send as text" rows give way,
    // the device chips and Send do not.
    var areaPx by remember { mutableIntStateOf(0) }
    var chipsPx by remember { mutableIntStateOf(0) }
    var extrasPx by remember { mutableIntStateOf(0) }
    // 2 text lines + 16 dp padding above and below them + 8 dp for the label on the border (+ 16 dp top padding without a title).
    val density = LocalDensity.current
    val lineHeight = MaterialTheme.typography.bodyLarge.lineHeight
    val linesPx = { n: Int -> with(density) { (lineHeight * n).roundToPx() + (if (title == null) 56.dp else 40.dp).roundToPx() } }
    val twoLinesPx = linesPx(2)
    val extras = UiText.sendExtrasShown(keyboardUp, areaPx, chipsPx, extrasPx, twoLinesPx)
    // Landscape or a large font: when the field cannot keep 4 lines (2 with the keyboard up) above the chips,
    // the page scrolls instead, so the field stays usable and every chip can be reached (I520).
    val scrolls = sendScrolls(areaPx, chipsPx, if (extras) extrasPx else 0, if (keyboardUp) twoLinesPx else linesPx(4))
    Box(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.fillMaxSize()) {
            title?.let { PaTopBar(it) }
            // Chips and Send keep their space, and the field gets what is left; when that is too little, the page scrolls.
            Column(Modifier.weight(1f).fillMaxWidth().onSizeChanged { areaPx = it.height }
                .then(if (scrolls) Modifier.verticalScroll(rememberScrollState()) else Modifier)) {
                // The field starts at 4 lines and grows with its text up to the free space, then scrolls inside;
                // with the keyboard up it shrinks first, to 2 lines while the chips still fit.
                OutlinedTextField(text, { text = it }, modifier = Modifier.rowPad.fillMaxWidth().then(if (scrolls) Modifier else Modifier.weight(1f, fill = false))
                    .padding(top = if (title == null) 16.dp else 0.dp), minLines = 4, label = { Text("Message") },
                    shape = RoundedCornerShape(12.dp),
                    colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = ex.tile, unfocusedContainerColor = ex.tile,
                        focusedBorderColor = cs.primary, unfocusedBorderColor = cs.outline))
                val counter = UiText.showCounter(bytes)
                if (extras) Column(Modifier.onSizeChanged { extrasPx = it.height }) {
                    if (text.isNotEmpty() || counter) {
                        Row(Modifier.padding(start = 32.dp, end = 32.dp, top = 6.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically) {
                            if (text.isNotEmpty()) TypeCaption(type) else Spacer(Modifier.width(1.dp))
                            if (counter) Text(UiText.counter(bytes), style = MaterialTheme.typography.bodySmall, color = cs.error)
                        }
                    }
                    if (detected != ContentType.TEXT) {
                        Row(Modifier.rowPad.fillMaxWidth().heightIn(min = 40.dp).toggleable(asText, role = Role.Checkbox) { asText = it },
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(asText, null)
                            Spacer(Modifier.width(12.dp))
                            Text("Send as text", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        }
                    }
                } else if (counter) {
                    // The counter does not give way: with the keyboard up it still says why Send is greyed.
                    Text(UiText.counter(bytes), Modifier.padding(start = 32.dp, end = 32.dp, top = 6.dp).fillMaxWidth(),
                        style = MaterialTheme.typography.bodySmall, color = cs.error, textAlign = TextAlign.End)
                }
                val chips = UiText.sortedByName(others(peers, me?.id).filter { it.pinned }, ::label)
                if (UiText.noDevicesShown(me != null, chips.size)) Column(Modifier.onSizeChanged { chipsPx = it.height }.rowPad.padding(top = 16.dp).fillMaxWidth()) {
                    Text(UiText.NO_DEVICES_TITLE, style = MaterialTheme.typography.titleMedium)
                    Text(UiText.NO_DEVICES_BODY, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    Text(UiText.PAIR_FIRST_CTA, Modifier.padding(top = 12.dp), style = MaterialTheme.typography.bodyMedium)
                    FilledTonalButton(onClick = onPair, Modifier.padding(top = 12.dp).heightIn(min = 48.dp)) { Text("Pair a device") }
                } else Column(Modifier.onSizeChanged { chipsPx = it.height }) {
                    SectionHeader(UiText.sendToHeader(sendTo.size, canReceive.size))
                    FlowRow(Modifier.rowPad.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (UiText.showAllChip(showAll, all.size, keyboardUp)) {
                            val on = picked.containsAll(all.map { it.id })
                            DeviceChip(PaIcons.Devices, "All", on, true) { picked.clear(); if (!on) picked.addAll(all.map { it.id }) }
                        }
                        for (p in chips) {
                            val ok = p.inAll
                            if (!UiText.chipVisible(ok && p.id in picked, keyboardUp)) continue
                            DeviceChip(platformIcon(p.platform), label(p), p.id in sendTo, ok, if (ok) null else UiText.status(p).second) {
                                if (!ok) { vm.tapGreyed(); scope.launch { snack.showSnackbar("${label(p)}: ${UiText.status(p).second}") } }
                                else if (p.id in picked) picked.remove(p.id) else picked.add(p.id)
                            }
                        }
                    }
                }
            }
            val running by vm.running.collectAsState()
            GreenButton(onClick = {
                // One send per tap: a second tap while the first is on its way does not send twice (I473).
                if (AppViewModel.claim(vm.running, "send")) {
                    scope.launch { vm.g.settings.saveSendTo(sendTo) }
                    scope.launch {
                        try { val r = vm.send(sendTo, text, asText); result = ((result?.first ?: 0) + 1) to r; onSent(r) }
                        finally { vm.running.update { it - "send" } }
                    }
                }
            }, text = UiText.sendLabel(sendTo.size, sendTo.singleOrNull()?.let { id -> peers.firstOrNull { it.id == id } }?.let(::label)), icon = PaIcons.Send,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 16.dp).fillMaxWidth().heightIn(min = 56.dp),
                enabled = sendTo.isNotEmpty() && text.isNotEmpty() && bytes <= SizeCap.MAX_CONTENT_BYTES && "send" !in running)
        }
        if (shared == null) SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp))
    }
}

/** The main screen's one snackbar for transient messages (I603); null outside it. */
internal val LocalSnackbar = androidx.compose.runtime.staticCompositionLocalOf<SnackbarHostState?> { null }

/** Hides the snackbar on screen when [key] changes, so a note about an earlier action does not sit over new content. */
@Composable
internal fun DismissSnackbarOnChange(state: SnackbarHostState, key: Any?) {
    LaunchedEffect(key) { state.currentSnackbarData?.dismiss() }
}

/** Detected type as quiet supporting text, not a control: "Will open as a link". */
@Composable
private fun TypeCaption(type: ContentType) {
    val cs = MaterialTheme.colorScheme
    val icon = when (type) {
        ContentType.URL -> PaIcons.Link
        ContentType.TEL -> PaIcons.Call
        ContentType.TEXT -> PaIcons.Notes
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
        Text(UiText.typeCaption(type), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}

/** One device toggle chip; a device that cannot receive is dimmed and a tap explains why (and refreshes the list). */
@Composable
private fun DeviceChip(icon: ImageVector, name: String, selected: Boolean, enabled: Boolean, status: String? = null, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    FilterChip(selected = selected && enabled, onClick = onClick,
        modifier = Modifier.alpha(if (enabled) 1f else 0.5f).semantics { if (status != null) contentDescription = "$name, $status" },
        label = { Text(name, Modifier.widthIn(max = 240.dp), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingIcon = { Icon(if (selected && enabled) PaIcons.Check else icon, null, Modifier.size(18.dp)) },
        colors = FilterChipDefaults.filterChipColors(containerColor = LocalPaExtra.current.tile, selectedContainerColor = cs.secondaryContainer),
        border = FilterChipDefaults.filterChipBorder(enabled = true, selected = selected && enabled, borderColor = cs.outline, selectedBorderColor = Color.Transparent))
}

/** History: filter chips, day groups, newest first, unread rows bold, expanded row actions. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HistoryScreen(vm: AppViewModel, onPair: () -> Unit = {}, onSend: () -> Unit = {}, onPeer: (String) -> Unit) {
    val rows by vm.history.collectAsState()
    val peers by vm.peers.collectAsState()
    val me by vm.self.collectAsState()
    var chip by rememberSaveable(stateSaver = chipSaver) { mutableStateOf<HistoryFilter.Chip>(HistoryFilter.Chip.All) }
    var dir by rememberSaveable { mutableStateOf<String?>(null) }
    var open by rememberSaveable { mutableStateOf<Long?>(null) }
    fun nameOf(id: String) = peers.firstOrNull { it.id == id }?.let { (it.name ?: label(it)) + if (it.removed) " (removed)" else "" } ?: "(removed)"
    val frows = rows.map { HistoryFilter.Row(it.peerId, it.direction == "RECEIVED") }
    val eff = HistoryFilter.effective(frows, chip)
    val ex = LocalPaExtra.current
    val now = System.currentTimeMillis()
    Column(Modifier.fillMaxSize()) {
        PaTopBar("History")
        if (rows.isEmpty()) {
            // Scrolls when landscape or a large font makes it taller than the screen (I480).
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                val cta = UiText.historyCta(me != null, others(peers, me?.id).count { it.pinned && !it.removed })
                EmptyState({ MessagesIllustration() }, "No messages yet",
                    "Everything you send or receive shows up here. Share a link from any app to send it to your devices.", top = 110.dp,
                    action = cta?.let { c -> {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(if (c == UiText.EmptyCta.PAIR) UiText.PAIR_FIRST_CTA else UiText.SEND_FIRST_CTA, Modifier.padding(bottom = 12.dp),
                                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
                            FilledTonalButton(onClick = if (c == UiText.EmptyCta.PAIR) onPair else onSend, Modifier.heightIn(min = 48.dp)) {
                                Text(if (c == UiText.EmptyCta.PAIR) "Pair a device" else "Send a message")
                            }
                        }
                    } })
            }
            return@Column
        }
        ChipRow(Modifier.padding(top = 4.dp, bottom = 8.dp)) {
            for (c in HistoryFilter.chips(frows, ::nameOf)) {
                val t = when (c) { HistoryFilter.Chip.All -> "All"; HistoryFilter.Chip.Unknown -> "Unknown"; is HistoryFilter.Chip.PeerChip -> c.name }
                PaChip(eff == c, t) { chip = c }
            }
            PaChip(dir == "SENT", "Sent") { dir = if (dir == "SENT") null else "SENT" }
            PaChip(dir == "RECEIVED", "Received") { dir = if (dir == "RECEIVED") null else "RECEIVED" }
        }
        val shown = rows.filter { HistoryFilter.matches(HistoryFilter.Row(it.peerId, it.direction == "RECEIVED"), eff) && (dir == null || it.direction == dir) }
        val days = shown.groupBy { UiText.day(it.at) }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 16.dp)) {
            for ((day, group) in days) {
                item(key = "day-$day") {
                    val l = UiText.dayLabel(group.first().at, now)
                    Text(l.uppercase(), Modifier.padding(start = 32.dp, end = 16.dp, top = 20.dp, bottom = 8.dp).semantics { contentDescription = l; heading() },
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                itemsIndexed(group, key = { _, h -> h.id }) { i, h ->
                    HistoryRow(vm, h, open == h.id, ::nameOf, onPeer,
                        Modifier.padding(top = if (i > 0) 2.dp else 0.dp).groupItem(i, group.size, if (open == h.id) ex.expandedRow else ex.tile)) { open = h.id }
                }
            }
        }
    }
}

/** One row of filter chips that scrolls sideways, so a long device name never wraps Sent or Received onto a second line (I571). */
@Composable
internal fun ChipRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** Saves the History device filter through a rotation (I523). */
internal val chipSaver = listSaver<HistoryFilter.Chip, String>(
    save = { c -> when (c) { HistoryFilter.Chip.All -> listOf("all"); HistoryFilter.Chip.Unknown -> listOf("unknown"); is HistoryFilter.Chip.PeerChip -> listOf("peer", c.peerId, c.name) } },
    restore = { l -> when (l[0]) { "unknown" -> HistoryFilter.Chip.Unknown; "peer" -> HistoryFilter.Chip.PeerChip(l[1], l[2]); else -> HistoryFilter.Chip.All } },
)

@Composable
internal fun PaChip(selected: Boolean, text: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    FilterChip(selected = selected, onClick = onClick, label = { Text(text, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis) },
        leadingIcon = if (selected) { { Icon(PaIcons.Check, null, Modifier.size(18.dp)) } } else null,
        colors = FilterChipDefaults.filterChipColors(containerColor = LocalPaExtra.current.tile, selectedContainerColor = cs.secondaryContainer),
        border = FilterChipDefaults.filterChipBorder(enabled = true, selected = selected, borderColor = cs.outline, selectedBorderColor = Color.Transparent))
}

private val CONTENT_TYPES = setOf("url", "text", "tel")

@Composable
private fun HistoryRow(vm: AppViewModel, h: com.pusharmor.store.HistoryEntity, expanded: Boolean, nameOf: (String) -> String,
                       onPeer: (String) -> Unit, modifier: Modifier, onOpen: () -> Unit) {
    val context = LocalContext.current
    val cs = MaterialTheme.colorScheme
    val event = h.type !in CONTENT_TYPES
    val unread = !h.read && !event
    val who = h.peerId?.let { nameOf(it) } ?: if (h.direction == "SENT") UiText.sentTitle(h.toRow().results, nameOf) else "Unknown sender"
    val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(h.at))
    val body = when (h.type) {
        "unreadable" -> "PushArmor received a message it could not read" + if (h.count > 1) " (${h.count})" else ""
        "invalid" -> "Invalid message received" + if (h.count > 1) " (${h.count})" else ""
        "denied" -> "Denied this device"
        "logged_out" -> "Logged out"
        "logged_in" -> "Logged in"
        else -> h.content.orEmpty()
    }
    // Unread: bold text, no dot, so the time column stays aligned (F32).
    val weight = if (unread) FontWeight.Bold else FontWeight.Normal
    Column(modifier.clickable(role = Role.Button) { onOpen(); vm.markRead(h.id) }
        .semantics {
            val st = listOfNotNull(if (unread) "Unread" else null, h.content?.let { if (expanded) "Expanded" else "Collapsed" })
            if (st.isNotEmpty()) stateDescription = st.joinToString(", ")
        }) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            if (event) Box(Modifier.size(40.dp), Alignment.Center) {
                Icon(when (h.type) { "logged_out" -> PaIcons.Pause; "logged_in" -> PaIcons.Check; else -> PaIcons.Info }, null, tint = cs.onSurfaceVariant)
            } else IconTile(when {
                h.direction == "SENT" -> PaIcons.NorthEast
                h.type == "url" -> PaIcons.Link
                h.type == "tel" -> PaIcons.Call
                else -> PaIcons.Notes
            })
            Column(Modifier.weight(1f)) {
                if (event) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(body, Modifier.weight(1f).padding(top = 10.dp), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        Text(time, Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                    if (h.peerId != null) Text(who, Modifier.clickable { h.peerId?.let(onPeer) },
                        style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(who, Modifier.weight(1f).clickable(enabled = h.peerId != null) { h.peerId?.let(onPeer) },
                            style = MaterialTheme.typography.bodyMedium, fontWeight = weight, color = cs.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(time, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                    val style = MaterialTheme.typography.bodyLarge.copy(fontWeight = weight)
                    val hc = h.content
                    when {
                        expanded && hc != null -> SelectionContainer { Text(hc, style = style) }
                        h.type == "url" -> MiddleEllipsisText(body, style, Modifier.fillMaxWidth())
                        h.type == "tel" -> Text(body, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        else -> Text(body, style = style, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        val hc = h.content
        if (expanded && hc != null) {
            Row(Modifier.padding(start = 72.dp, end = 16.dp, bottom = 8.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (h.type == "url") com.pusharmor.protocol.UrlCheck.parse(hc)?.let { u ->
                    RowAction("Open", PaIcons.OpenInNew) { startOrToast(context, Intent(Intent.ACTION_VIEW, Uri.parse(u.href)).addCategory(Intent.CATEGORY_BROWSABLE)) { vm.message.value = it } }
                }
                if (h.type == "tel" && com.pusharmor.protocol.Phone.isPhone(hc)) {
                    RowAction("Dial", PaIcons.Call) { startOrToast(context, Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(hc))), NO_APP_DIAL) { vm.message.value = it } }
                }
                RowAction("Copy", PaIcons.ContentCopy) { com.pusharmor.app.notify.ActionActivity.copy(context, hc) }
                RowAction("Share", PaIcons.Share) {
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, hc), null))
                }
            }
        }
    }
}

/** Outlined action chip (History Copy and Share; Settings Log out and Delete account, I606); [error] paints it red. */
@Composable
private fun RowAction(text: String, icon: ImageVector, enabled: Boolean = true, error: Boolean = false, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    AssistChip(onClick = onClick, label = { Text(text) }, enabled = enabled,
        leadingIcon = { Icon(icon, null, Modifier.size(18.dp)) },
        colors = AssistChipDefaults.assistChipColors(containerColor = LocalPaExtra.current.tile, leadingIconContentColor = if (error) cs.error else cs.primary,
            labelColor = if (error) cs.error else cs.onSurface),
        border = AssistChipDefaults.assistChipBorder(enabled = enabled, borderColor = cs.outline))
}

/** A plain settings row (no icon tile); [onClick] null makes it static text. */
@Composable
private fun SettingRow(title: String, sub: String? = null, modifier: Modifier, color: Color = Color.Unspecified,
                       trailing: (@Composable () -> Unit)? = null, onClick: (() -> Unit)?) {
    Row(modifier.heightIn(min = 56.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
        .padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        trailing?.let { Spacer(Modifier.width(16.dp)); it() }
    }
}

/** Settings (section 8): one group per section. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(vm: AppViewModel, onDeleteAccount: () -> Unit, onSignedOut: () -> Unit, onBack: (() -> Unit)? = null, signedIn: Boolean = true) {
    val prefs by vm.prefs.collectAsState()
    val context = LocalContext.current
    val me by vm.self.collectAsState()
    var confirmHistory by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    val running by vm.running.collectAsState()
    var pickDays by rememberSaveable { mutableStateOf(false) }
    var pickTheme by rememberSaveable { mutableStateOf(false) }
    var pickPush by rememberSaveable { mutableStateOf(false) }
    val up = prefs?.get(Settings.K.PUSH_TYPE) == "unifiedpush"
    val themePref = ThemePref.parse(prefs?.get(Settings.K.THEME))
    fun b(k: androidx.datastore.preferences.core.Preferences.Key<Boolean>, d: Boolean) = prefs?.get(k) ?: d
    val cs = MaterialTheme.colorScheme
    val days = prefs?.get(Settings.K.HISTORY_DAYS) ?: 30
    val pad = Modifier.padding(horizontal = 16.dp)
    val external: @Composable () -> Unit = { Icon(PaIcons.OpenInNew, null, tint = cs.onSurfaceVariant) }
    Column(Modifier.fillMaxSize()) {
        PaTopBar("Settings", navigationIcon = { onBack?.let { IconButton(onClick = it) { Icon(PaIcons.ArrowBack, "Back") } } })
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            if (signedIn) {
                SectionHeader("Device name")
                GroupedList(listOf<@Composable (Modifier) -> Unit> { m ->
                    NameEditRow(me?.name ?: "", m) { vm.rename(it) }
                })
            }
            SectionHeader("Appearance")
            GroupedList(listOf<@Composable (Modifier) -> Unit> { m ->
                SettingRow("Theme", themePref.label, m) { pickTheme = true }
            })
            // Logged out: only what needs no account and no device (I612).
            if (!signedIn) return@Column
            SectionHeader("Sending")
            GroupedList(listOf<@Composable (Modifier) -> Unit>(
                { m -> SwitchRow("Show \"All\" option", b(Settings.K.SHOW_ALL, true), modifier = m.then(pad)) { vm.setPref(Settings.K.SHOW_ALL, it) } },
            ))
            SectionHeader("History")
            GroupedList(listOf<@Composable (Modifier) -> Unit>(
                { m -> SettingRow("Keep messages for", UiText.days(days), m) { pickDays = true } },
                { m -> SettingRow("Delete all history", modifier = m, color = cs.error) { confirmHistory = true } },
            ))
            SectionHeader("Notifications")
            GroupedList(buildList<@Composable (Modifier) -> Unit> {
                // Received messages (I463): what a notification tap does.
                add { m -> SwitchRow("Tap opens link", b(Settings.K.TAP_OPENS_LINK, true), modifier = m.then(pad)) { vm.setPref(Settings.K.TAP_OPENS_LINK, it) } }
                add { m ->
                    SettingRow("Notifications", modifier = m, trailing = external) {
                        context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
                    }
                }
                add { m ->
                    SwitchRow("Show message content in notifications", b(Settings.K.SHOW_CONTENT, true), sub = "When off, notifications show only \"New message\".",
                        modifier = m.then(pad)) { vm.setPref(Settings.K.SHOW_CONTENT, it) }
                }
                add { m ->
                    SwitchRow("Show message content on lock screen", b(Settings.K.LOCK_SCREEN, true), enabled = b(Settings.K.SHOW_CONTENT, true),
                        sub = "When off, the lock screen shows only \"New message\".", modifier = m.then(pad)) { vm.setPref(Settings.K.LOCK_SCREEN, it) }
                }
                add { m ->
                    SettingRow("System lock screen setting", modifier = m, trailing = external) {
                        try { context.startActivity(Intent("android.settings.NOTIFICATION_SETTINGS")) } catch (e: Exception) { }
                    }
                }
                add { m ->
                    SwitchRow("Send messages to watch", b(Settings.K.WATCH, true), sub = "When off, nothing is sent to your watch.",
                        modifier = m.then(pad)) { vm.setPref(Settings.K.WATCH, it) }
                }
                if (vm.g.push.hasPlayServices) add { m ->
                    Column(m) {
                        SettingRow("Push method", pushLabel(up), Modifier) { pickPush = true }
                        if (up && UnifiedPushSupport.distributors(context).size > 1) Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                            for (d in UnifiedPushSupport.distributors(context)) TextButton(onClick = { UnifiedPushSupport.pick(vm.g, d) }) { Text(d) }
                        }
                    }
                }
            })
            SectionHeader("Account")
            me?.email?.let { email ->
                // Dim label, then the email on its own line; a long address ends in an ellipsis (I460).
                GroupedList(listOf<@Composable (Modifier) -> Unit> { m ->
                    Column(m.heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text("Logged in as", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        Text(email, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (email.endsWith("@privaterelay.appleid.com")) Text(UiText.APPLE_RELAY_HINT,
                            style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    }
                })
            }
            // Wraps to two lines at a large font instead of squeezing both buttons (I480); centred, Delete account on the left (I606).
            FlowRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                RowAction("Delete account", PaIcons.Delete, error = true) { confirmDelete = true }
                RowAction("Log out", PaIcons.Logout, enabled = "logout" !in running) { vm.signOut(onSignedOut) }
                // Log out on a slow or missing connection: visible progress beside the buttons (I473).
                if ("logout" in running) androidx.compose.material3.CircularProgressIndicator(Modifier.size(24.dp).align(Alignment.CenterVertically).semantics { contentDescription = "Logging out" })
            }
        }
    }
    if (pickDays) ChoiceDialog("Keep messages for", listOf(1, 7, 30, 90, 365), days, { UiText.days(it) }, onDismiss = { pickDays = false }) {
        vm.setPref(Settings.K.HISTORY_DAYS, it)
    }
    if (pickTheme) ChoiceDialog("Theme", ThemePref.entries, themePref, { it.label }, note = "Dark uses a true black background.",
        onDismiss = { pickTheme = false }) { vm.setTheme(it) }
    if (pickPush) ChoiceDialog("Push method", listOf(false, true), up, ::pushLabel, onDismiss = { pickPush = false }) { if (it != up) vm.switchPush(it) }
    if (confirmHistory) AlertDialog(onDismissRequest = { confirmHistory = false }, text = { Text("Delete all history?") },
        confirmButton = { TextButton(onClick = { vm.deleteAllHistory(); confirmHistory = false }) { Text("Delete") } },
        dismissButton = { TextButton(onClick = { confirmHistory = false }) { Text("Cancel") } })
    if (confirmDelete) DeleteAccountDialog(onConfirm = { confirmDelete = false; onDeleteAccount() }) { confirmDelete = false }
}

private fun pushLabel(up: Boolean) = if (up) "UnifiedPush app" else "Google (default)"

/**
 * Standard single-choice dialog (I602): radio rows, each row the tap target; OK applies the choice, Cancel keeps the old one.
 * The choice is kept by its index, so it stays through a rotation.
 */
@Composable
internal fun <T> ChoiceDialog(title: String, options: List<T>, current: T, label: (T) -> String, note: String? = null,
                              onDismiss: () -> Unit, onChoose: (T) -> Unit) {
    var picked by rememberSaveable { mutableIntStateOf(options.indexOf(current)) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) },
        text = {
            Column(Modifier.selectableGroup()) {
                options.forEachIndexed { i, o ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = i == picked, role = Role.RadioButton) { picked = i },
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(i == picked, null)
                        Spacer(Modifier.width(12.dp))
                        Text(label(o))
                    }
                }
                note?.let { Text(it, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        },
        confirmButton = { TextButton(onClick = { options.getOrNull(picked)?.let(onChoose); onDismiss() }) { Text("OK") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

/** Delete account confirmation: a standard dialog with a title, a red Continue, and Cancel (I603). */
@Composable
internal fun DeleteAccountDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Delete account") }, text = { Text(UiText.DELETE_CONFIRM) },
        confirmButton = {
            TextButton(onClick = onConfirm, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Continue") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
