package com.pusharmor.app.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings as SysSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.ui.graphics.lerp
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
import androidx.compose.material3.ExtendedFloatingActionButton
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.Layout
import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material3.LocalTextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.PackageManagerCompat
import androidx.core.content.IntentCompat
import com.pusharmor.app.BuildConfig
import com.pusharmor.app.R
import com.pusharmor.app.ScreenshotMode
import com.pusharmor.app.data.Settings
import com.pusharmor.app.notify.AppEffects
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.notify.PeerStatus
import com.pusharmor.app.notify.Policy
import com.pusharmor.app.notify.peerStatusLabel
import com.pusharmor.app.push.UnifiedPushSupport
import com.pusharmor.app.session.Session
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
import com.pusharmor.app.ui.theme.TonalGreenButton
import com.pusharmor.app.ui.theme.softGreenFill
import com.pusharmor.app.ui.theme.softGreenText
import com.pusharmor.app.ui.theme.SectionHeader
import com.pusharmor.app.ui.theme.ThemePref
import com.pusharmor.app.ui.theme.StatusLine
import com.pusharmor.app.ui.theme.groupItem
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Countdown
import com.pusharmor.protocol.PairDecide
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.SizeCap
import com.pusharmor.protocol.engine.PairingEngine
import com.pusharmor.protocol.engine.PairingRow
import com.pusharmor.store.toRow
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.update
import java.text.DateFormat
import java.util.Date

internal fun label(p: Peer) = p.name ?: "${AppEffects.platformLabel(p.platform)} device added ${AppEffects.dateLabel(p.created)}"

/** Peers other than self; none until self is known, so the own device never shows as a peer. */
internal fun others(peers: List<Peer>, selfId: String?): List<Peer> = if (selfId == null) emptyList() else peers.filter { it.id != selfId }

/** A not-yet-paired device this device rejected, with no pairing open: gone from the list until a new pairing starts. */
internal fun rejectedHidden(p: Peer, pairing: Set<String>): Boolean = p.deniedByMe && !p.pinned && !p.removed && p.id !in pairing

/** The Devices list: a removed device only while it is still pinned or pairing, and no rejected device. */
internal fun devicesShown(others: List<Peer>, pairing: Set<String>): List<Peer> =
    others.filter { !(it.removed && !it.pinned && it.id !in pairing) && !rejectedHidden(it, pairing) }

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

/** The Devices screen while open: one relay server check at open, then a 30 s tick for the countdown text only. */
internal suspend fun devicesScreenOpen(vm: AppViewModel, tick: suspend (Long) -> Unit = { delay(it) }, onTick: () -> Unit) {
    vm.onPeersOpen()
    while (true) { tick(30_000); onTick() }
}

/** Peers screen (section 8): banners, pairing cards, This device, the peer group. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeersScreen(vm: AppViewModel) {
    val peers by vm.peers.collectAsState()
    val rows by vm.pairings.collectAsState()
    val highlight by vm.highlight.collectAsState()
    val prefs by vm.prefs.collectAsState()
    val refreshing by vm.refreshing.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    // Saved, so both dialogs stay open through a rotation; the device by its id.
    var confirmRemove by rememberSaveable { mutableStateOf<String?>(null) }
    var pairHowTo by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { devicesScreenOpen(vm) { now = System.currentTimeMillis() } }
    val me by vm.self.collectAsState()
    // No paired device: the first-pair steps and the Waiting to pair row (was a screen in place of the tabs).
    val firstDevice = me != null && UiText.noPairedDevice(others(peers, me?.id))
    val pairingIds = rows.map { it.peerId }.toSet()
    val list = devicesShown(others(peers, me?.id), pairingIds)
    // Each section is in alphabetical order of the shown name.
    val pairing = UiText.sortedByName(list.filter { p -> rows.any { it.peerId == p.id } }, ::label)
    val plain = UiText.sortedByName(list.filter { p -> rows.none { it.peerId == p.id } }, ::label)
    val lastRefresh = prefs?.get(Settings.K.LAST_REFRESH) ?: 0
    val canRefresh = now - lastRefresh >= Session.REFRESH_GREY_MS
    // Refresh turns on again when its grey time ends.
    LaunchedEffect(lastRefresh) {
        val left = lastRefresh + Session.REFRESH_GREY_MS - System.currentTimeMillis()
        if (left > 0) { delay(left); now = System.currentTimeMillis() }
    }
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
    // Pair a new device is a floating button, so it stays in reach however long the list is.
    // Its measured height, as it grows with the font size; the list keeps its last row clear of it.
    val density = LocalDensity.current
    var fabH by remember { mutableStateOf(FAB_SPACE - 16.dp) }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, contentWindowInsets = WindowInsets(0), topBar = {
        PaTopBar("Devices", actions = {
            IconButton(onClick = { vm.refresh() }, enabled = canRefresh && !refreshing) { Icon(PaIcons.Refresh, "Refresh") }
        })
    }, floatingActionButton = {
        ExtendedFloatingActionButton(onClick = { pairHowTo = true }, modifier = Modifier.onSizeChanged { fabH = with(density) { it.height.toDp() } },
            icon = { Icon(PaIcons.Add, null) }, text = { Text("Pair a new device") })
    }) { inner ->
        // The first banner card keeps the same gap under the top bar as the cards on the other tabs.
        // The bottom padding keeps the last row clear of the floating button.
        // Pull down to refresh; the indicator also shows while the Refresh button runs.
        PullToRefreshBox(refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.padding(inner).fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = PaddingValues(top = 8.dp, bottom = fabH + 16.dp + 16.dp)) {
                item(key = "banners") {
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Banners(vm, prefs)
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
                        PeerRow(vm, p, now, p.id == highlight, me?.id, Modifier.padding(top = if (i > 0) 2.dp else 0.dp).groupItem(i, plain.size)) { confirmRemove = p.id }
                    }
                } else if (pairing.isEmpty() && firstDevice) {
                    item(key = "waiting-header") { SectionHeader("Waiting to pair") }
                    item(key = "waiting") {
                        ListItem(modifier = Modifier.padding(horizontal = 16.dp), colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            leadingContent = { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 3.dp) },
                            headlineContent = { Text(UiText.FIRST_DEVICE_WAITING, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) })
                    }
                }
            }
        }
    }
    peers.firstOrNull { it.id == confirmRemove }?.let { p ->
        val x = label(p)
        AlertDialog(onDismissRequest = { confirmRemove = null },
            text = { Text(UiText.removeDeviceBody(x)) },
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

/** Height of the Devices floating button with its margin, kept clear by the list and the snackbar. */
internal val FAB_SPACE = 72.dp

/** First-device steps: one card, a filled numbered circle per step, dividers between the steps, as on iOS. */
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
 * This device's name, renamed in place: the pencil turns the name into a field with its text selected,
 * Cancel and Save beside it. Done saves, Back cancels; an invalid name shows why and Save is greyed.
 */
@Composable
internal fun NameEditRow(current: String, modifier: Modifier = Modifier, onSave: (String) -> Unit) {
    val st = rememberSaveable(saver = NameEdit.Saver) { NameEdit() }
    val cs = MaterialTheme.colorScheme
    if (!st.editing) {
        SettingRow(current, null, modifier, trailing = { Icon(PaIcons.Edit, null, tint = cs.onSurfaceVariant) }) { st.start(current) }
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

/** In-place rename state: Start selects the name, Cancel drops the edit, Save returns the name only when it is valid. */
internal class NameEdit(editing: Boolean = false, typed: TextFieldValue = TextFieldValue()) {
    var editing by mutableStateOf(editing)
    var typed by mutableStateOf(typed)
    /** Empty, too long, or not plain ASCII: the reason, shown under the field; Save is greyed. */
    val error: String? get() = UiText.nameError(typed.text)
    fun start(current: String) { typed = TextFieldValue(current, TextRange(0, current.length)); editing = true }
    fun cancel() { editing = false }
    fun save(): String? = typed.text.takeIf { error == null }?.also { editing = false }

    companion object {
        /** Kept through a rotation. */
        val Saver = listSaver<NameEdit, Any>(
            save = { listOf(it.editing, it.typed.text, it.typed.selection.start, it.typed.selection.end) },
            restore = { NameEdit(it[0] as Boolean, TextFieldValue(it[1] as String, TextRange(it[2] as Int, it[3] as Int))) })
    }
}

@Composable
private fun Banners(vm: AppViewModel, prefs: androidx.datastore.preferences.core.Preferences?) {
    val context = LocalContext.current
    // Read here, so every check below runs again on each return to the app.
    val tick = resumeTick()
    val n = vm.g.notifier
    val type = prefs?.get(Settings.K.PUSH_TYPE)
    val noPushApp = remember(tick, prefs == null, type) { prefs != null && UnifiedPushSupport.noPushApp(context, type, vm.g.push.hasPlayServices) }
    n.blockedChannelPeer(vm.peerEntities.collectAsState().value)?.let { BannerRow(UiText.blockedChannel(it.name), "Fix", fault = true, PaIcons.NotificationsOff) {
        safeStart(context, Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
    } }
    if (noPushApp && vm.g.push.hasPlayServices) TextButton(onClick = { vm.switchPush(toUp = false) }) { Text("Switch back to Google") }
    val upAt = prefs?.get(Settings.K.UP_REGISTERED_AT)
    if (prefs?.get(Settings.K.PUSH_TYPE) == "unifiedpush" && upAt != null && !Settings.flagOf(prefs, Settings.K.UP_VERIFIED, false) && System.currentTimeMillis() - upAt > 10 * 60_000) {
        BannerRow("This push server did not deliver. Check your UnifiedPush app.", "Retry", fault = true, PaIcons.Info) { vm.retryPush() }
        if (vm.g.push.hasPlayServices) TextButton(onClick = { vm.switchPush(toUp = false) }) { Text("Switch back to Google") }
    }
    val st = remember(tick) { try { PackageManagerCompat.getUnusedAppRestrictionsStatus(context).get(2, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Exception) { 0 } }
    if (st == androidx.core.content.UnusedAppRestrictionsConstants.API_31) {
        BannerRow(UiText.HIBERNATION_BANNER, "Settings", fault = false, PaIcons.Info) {
            safeStart(context, IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName))
        }
    }
    val am = context.getSystemService(android.app.ActivityManager::class.java)
    if (am.isBackgroundRestricted) BannerRow("Battery setting Restricted delays messages.", "Settings", fault = false, PaIcons.Info) {
        safeStart(context, Intent(SysSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)))
    }
}

/**
 * "This device cannot receive messages." above [content], on every signed-in tab and on the logged-out screen.
 * [topInset] pads the card below the status bar and takes that inset off [content], for screens that pad it themselves.
 * [enabled] false shows no card but keeps [content] in place, so its state stays when the card may show again.
 */
@Composable
internal fun CannotReceiveHost(vm: AppViewModel, topInset: Boolean, enabled: Boolean = true, content: @Composable () -> Unit) {
    val context = LocalContext.current
    // Read here, so the checks below run again on each return to the app.
    val tick = resumeTick()
    val n = vm.g.notifier
    val prefs = vm.prefs.collectAsState().value
    val google = vm.g.push.hasPlayServices
    val type = prefs?.get(Settings.K.PUSH_TYPE)
    // Live on each resume: a UnifiedPush app installed meanwhile clears the card and gets registered.
    val noPushApp = remember(tick, prefs == null, type) { prefs != null && UnifiedPushSupport.noPushApp(context, type, google) }
    val refused = remember(tick, prefs) { UnifiedPushSupport.refused(context, prefs, google) }
    val setup = remember(tick, prefs) { UnifiedPushSupport.setupError(context, prefs, google) }
    LaunchedEffect(tick) { vm.registerIfInstalled() }
    val off = !n.enabled() || n.mainChannelsBlocked()
    val closed by vm.cannotReceiveClosed.collectAsState()
    val relay = relayFaultShown(Settings.flagOf(prefs, Settings.K.RELAY_FAULT, false), type, google)
    // The push address could not be sent: line 2 says why.
    val pushError = prefs?.get(Settings.K.PUSH_ERROR)
    val cannot = UiText.cannotReceive(n.enabled(), n.mainChannelsBlocked(), noPushApp, refused != null || setup != null || pushError != null, relay)
    LaunchedEffect(cannot) { if (!cannot) vm.cannotReceiveClosed.value = false }
    val shown = enabled && cannot && !closed
    var getApp by rememberSaveable { mutableStateOf(false) }
    val top = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
    Column(Modifier.fillMaxSize()) {
        if (shown) {
            // Check again reads each cause on this device live, at the tap.
            val check = UiText.CHECK_AGAIN to {
                val p = vm.prefs.value
                vm.checkAgain(!n.enabled() || n.mainChannelsBlocked() || (p != null && UnifiedPushSupport.noPushApp(context, p[Settings.K.PUSH_TYPE], google)) ||
                    UnifiedPushSupport.refused(context, p, google) != null || UnifiedPushSupport.setupError(context, p, google) != null)
            }
            // Check again on the left; the card's own fix, the primary action, on the right.
            val (reason, actions) = when {
                off -> UiText.CANNOT_RECEIVE_NOTIFICATIONS_OFF to listOf<Pair<String, () -> Unit>>(check, "Fix" to {
                    safeStart(context, Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
                })
                noPushApp -> UiText.noPushApp(google) to listOf(check, UiText.GET_PUSH_APP to { getApp = true })
                refused != null -> UiText.pushRefused(refused.first, refused.second, google) to listOf(check)
                setup != null -> setup to listOf(check)
                pushError != null -> pushError to listOf(check)
                else -> UiText.RELAY_FAULT to listOf(check)
            }
            CannotReceiveBanner(reason, actions,
                Modifier.then(if (topInset) Modifier.windowInsetsPadding(top) else Modifier).padding(horizontal = 16.dp, vertical = 8.dp),
                onClose = { vm.cannotReceiveClosed.value = true })
        }
        if (getApp) GetPushAppDialog(vm) { getApp = false }
        Box(Modifier.weight(1f).then(if (shown && topInset) Modifier.consumeWindowInsets(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)) else Modifier)) { content() }
    }
}

/**
 * Store listings of the UnifiedPush apps: Google Play for the play build on a device with Play services, else F-Droid
 * (a device without them cannot install from Play). Sunup is on F-Droid only.
 */
internal fun ntfyUrl(playBuild: Boolean, google: Boolean): String =
    if (playBuild && google) "https://play.google.com/store/apps/details?id=io.heckel.ntfy" else "https://f-droid.org/packages/io.heckel.ntfy/"
private const val SUNUP_URL = "https://f-droid.org/packages/org.unifiedpush.distributor.sunup/"

/** Get a UnifiedPush app: ntfy (recommended) or Sunup, each with one line on what it is; a tap opens its store listing. */
@Composable
internal fun GetPushAppDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val google = vm.g.push.hasPlayServices
    fun get(url: String) { onDismiss(); startOrToast(context, Intent(Intent.ACTION_VIEW, Uri.parse(url))) { vm.message.value = it } }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(UiText.GET_PUSH_APP) },
        text = {
            Column {
                for ((name, about, url) in listOf(Triple(UiText.NTFY_NAME, UiText.NTFY_ABOUT, ntfyUrl(BuildConfig.FLAVOR == "play", google)),
                    Triple(UiText.SUNUP_NAME, UiText.SUNUP_ABOUT, SUNUP_URL))) {
                    ListItem(modifier = Modifier.clickable(role = Role.Button) { get(url) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        headlineContent = { Text(name) }, supportingContent = { Text(about) })
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

/** The relay-side card: the stored mark, for Google push only (UnifiedPush faults are never on the relay server's side). */
internal fun relayFaultShown(fault: Boolean, type: String?, google: Boolean): Boolean = fault && !UnifiedPushSupport.active(type, google)

/** Push method option for Google push. A package name always holds a dot, so it never matches. */
internal const val PUSH_GOOGLE = "google"

/** Push method options: Google where Play services run (never on the build without Google), then each installed UnifiedPush app by name. */
internal fun pushOptions(google: Boolean, apps: List<Pair<String, String>>): List<String> =
    (if (google) listOf(PUSH_GOOGLE) else emptyList()) + UiText.sortedByName(apps, { it.second }).map { it.first }

/** Push method value: Google, the UnifiedPush app's name, or None available when no push service can be used. */
internal fun pushMethodName(o: String?, apps: List<Pair<String, String>>): String =
    if (o == PUSH_GOOGLE) "Google" else apps.firstOrNull { it.first == o }?.second ?: UiText.PUSH_NONE_AVAILABLE

/** The option in use: Google unless UnifiedPush is the push method, then the saved UnifiedPush app (null when none). */
internal fun pushCurrent(type: String?, google: Boolean, saved: String?): String? =
    if (UnifiedPushSupport.active(type, google)) saved else PUSH_GOOGLE

/** "This device cannot receive messages." with its reason on line 2, its actions, and an X that hides it until the next app open. */
@Composable
private fun CannotReceiveBanner(reason: String, actions: List<Pair<String, () -> Unit>>, modifier: Modifier, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card(modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = cs.errorContainer, contentColor = cs.onErrorContainer)) {
        Column(Modifier.padding(start = 16.dp, top = 16.dp, end = 8.dp, bottom = 8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Icon(PaIcons.NotificationsOff, null)
                Column(Modifier.weight(1f)) {
                    Text(UiText.CANNOT_RECEIVE, style = MaterialTheme.typography.bodyMedium)
                    Text(reason, style = MaterialTheme.typography.bodyMedium)
                }
                IconButton(onClick = onClose, Modifier.size(24.dp)) { Icon(PaIcons.Close, "Close") }
            }
            if (actions.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                for ((label, onClick) in actions) TextButton(onClick = onClick, colors = ButtonDefaults.textButtonColors(contentColor = cs.onErrorContainer)) { Text(label) }
            }
        }
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

/** One peer in the Peers group: icon tile, name, platform, status line, overflow menu; the menu holds the per-device options. */
@Composable
private fun PeerRow(vm: AppViewModel, p: Peer, now: Long, highlighted: Boolean, selfId: String?, modifier: Modifier, onRemove: () -> Unit) {
    val x = label(p)
    var menu by remember { mutableStateOf(false) }
    val pairingAgain by vm.pairingAgain.collectAsState()
    val running by vm.running.collectAsState()
    val ents by vm.peerEntities.collectAsState()
    val prefs by vm.prefs.collectAsState()
    val shareShown = prefs?.get(Settings.K.SHARE_OFF)?.contains(p.id) != true
    val grey = p.missing || !p.reachable
    val cs = MaterialTheme.colorScheme
    // Pairing and note lines replace the status line (catalog order).
    val stateText = when {
        !p.pinned -> null
        p.notPairedOnPeer -> if (p.listDeniesMe) UiText.rejectedBy(x) else UiText.notPairedOn(x)
        p.waiting -> UiText.waitingCodesMatch(x)
        p.missing -> null
        p.declined -> UiText.rejectedBy(x)
        else -> null
    }
    val lines = listOfNotNull(p.note, stateText)
    Column(modifier.then(if (highlighted) Modifier.background(cs.secondaryContainer) else Modifier)) {
        ListItem(
            modifier = Modifier.clickable(enabled = grey, role = Role.Button) { vm.tapGreyed() },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            leadingContent = { IconTile(platformIcon(p.platform), dim = grey) },
            headlineContent = {
                Text(x, Modifier.alpha(if (grey) 0.6f else 1f), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            },
            supportingContent = {
                // Status icons sit beside lines 2-3, so the name line keeps its full width.
                LinesBesideIcons({
                    Text(AppEffects.platformLabel(p.platform))
                    if (lines.isEmpty()) { val (k, w) = UiText.status(p); StatusLine(k, w) } else for (l in lines) Text(l)
                }) {
                    val se = ents.firstOrNull { it.id == p.id }
                    if (p.pinned && se != null) {
                        PeerStatusIcons(listOf(
                            PaIcons.Send to PeerStatus("Send screen", !p.hidden),
                            PaIcons.Notifications to PeerStatus("Content in notifications", se.showContent && Policy.peerSwitchEnabled(Settings.flagOf(prefs, Settings.K.SHOW_CONTENT, true))),
                            PaIcons.Lock to PeerStatus("Content on lock screen", se.lockScreen && Policy.peerLockEnabled(Settings.flagOf(prefs, Settings.K.SHOW_CONTENT, true), Settings.flagOf(prefs, Settings.K.LOCK_SCREEN, true), se.showContent)),
                            PaIcons.Watch to PeerStatus("Watch", se.watch && Policy.peerSwitchEnabled(Settings.flagOf(prefs, Settings.K.WATCH, true))),
                            PaIcons.Share to PeerStatus("Sharing shortcut", shareShown),
                        ))
                    }
                }
            },
            trailingContent = {
                Box {
                    IconButton(onClick = { menu = true }) { Icon(PaIcons.MoreVert, UiText.moreOptionsFor(x)) }
                    // Cap the height to the visible window less the menu's own 48dp margins, so a tall menu (large font, short window)
                    // scrolls inside the screen instead of running under the status or navigation bar.
                    val view = LocalView.current
                    val visible = android.graphics.Rect().also { view.getWindowVisibleDisplayFrame(it) }.height()
                    val maxH = with(LocalDensity.current) { visible.toDp() } - 96.dp
                    DropdownMenu(menu, { menu = false }, Modifier.heightIn(max = maxH.coerceAtLeast(96.dp))) {
                        val e = ents.firstOrNull { it.id == p.id }
                        val gs = vm.g.settings
                        val showOn = Policy.peerSwitchEnabled(gs.showContent)
                        val lockOn = Policy.peerLockEnabled(gs.showContent, gs.lockScreen, e?.showContent ?: true)
                        // The tick is the state, so each row reads as a checkbox; "Show device on Send screen" is stored as the inverse (hidden).
                        if (p.pinned) CheckItem("Show device on Send screen", !p.hidden) { menu = false; vm.setHidden(p.id, !p.hidden) }
                        if (p.pinned && e != null) {
                            CheckItem("Show message content in notifications", e.showContent && showOn, showOn) { vm.setPeerSwitch(p.id, showContent = !e.showContent) }
                            CheckItem("Show message content on lock screen", e.lockScreen && lockOn, lockOn) { vm.setPeerSwitch(p.id, lock = !e.lockScreen) }
                            CheckItem("Send messages to watch", e.watch && Policy.peerSwitchEnabled(gs.watch), Policy.peerSwitchEnabled(gs.watch)) { vm.setPeerSwitch(p.id, watch = !e.watch) }
                        }
                        // Per device, on by default.
                        if (p.pinned) CheckItem("Show shortcut in sharing menu", shareShown) { menu = false; vm.setShareShown(p.id, !shareShown) }
                        HorizontalDivider()
                        if (p.offersPairAgain) DropdownMenuItem(text = { Text("Cancel pairing request") }, onClick = { menu = false; vm.cancelPairing(p.id) })
                        if (p.missing) DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; vm.localDelete(p.id) })
                        DropdownMenuItem(text = { Text("Remove device from account") }, onClick = { menu = false; onRemove() })
                    }
                }
            },
        )
        val inset = Modifier.padding(start = 72.dp, end = 16.dp)
        if (selfId != null && p.platform == "cli" && !p.pinned && !p.hidden) {
            Text(UiText.pairCommandLine(x, selfId), inset.padding(bottom = 8.dp), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        when {
            !p.pinned -> Row(inset.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { vm.deny(p.id) }, Modifier.heightIn(min = 48.dp), enabled = "deny:${p.id}" !in running, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.error)) { Text("Reject") }
                TonalGreenButton(onClick = { vm.pair(p.id) }, text = "Pair", enabled = "pair:${p.id}" !in running)
            }
            p.notPairedOnPeer -> Row(inset.padding(bottom = 8.dp)) {
                if (p.offersPairAgain) OutlinedButton(onClick = { vm.pairAgain(p.id) }, Modifier.heightIn(min = 48.dp), enabled = p.id !in pairingAgain) { Text("Pair again") }
                else OutlinedButton(onClick = { vm.cancelPairing(p.id) }, Modifier.heightIn(min = 48.dp)) { Text("Cancel pairing request") }
            }
            p.waiting -> ButtonRow(inset.padding(bottom = 8.dp)) {
                if (p.offersPairAgain) OutlinedButton(onClick = { vm.pairAgain(p.id) }, Modifier.heightIn(min = 48.dp), enabled = p.id !in pairingAgain) { Text("Pair again") }
                else OutlinedButton(onClick = { vm.cancelPairing(p.id) }, Modifier.heightIn(min = 48.dp)) { Text("Cancel pairing request") }
                WaitingSendAgain(vm, p, now)
            }
        }
    }
}

/** Small non-interactive icons for the per-device settings; greyed when off; one combined label for the group. */
@Composable
internal fun PeerStatusIcons(items: List<Pair<ImageVector, PeerStatus>>) {
    val label = peerStatusLabel(items.map { it.second })
    Row(Modifier.clearAndSetSemantics { contentDescription = label }, horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        for ((icon, st) in items) Icon(icon, null, Modifier.size(16.dp).alpha(if (st.on) 1f else 0.38f))
    }
}

/** The platform names, as the device rows show them. */
private val PLATFORM_LABELS = listOf("android", "ios", "chrome", "firefox", "cli").map { AppEffects.platformLabel(it) }

/**
 * A device row's lines with the status icons at their right. The icons go under the lines when the lines beside them
 * would be narrower than the longest platform name (a small screen or a large font), so no line breaks into fragments.
 */
@Composable
internal fun LinesBesideIcons(lines: @Composable () -> Unit, icons: @Composable () -> Unit) {
    val measurer = rememberTextMeasurer()
    val style = LocalTextStyle.current
    val need = PLATFORM_LABELS.maxOf { measurer.measure(it, style).size.width }
    Layout({ Column { lines() }; Box { icons() } }) { (t, i), c ->
        val ip = i.measure(c.copy(minWidth = 0, minHeight = 0))
        val gap = if (ip.width > 0) 8.dp.roundToPx() else 0
        val w = c.maxWidth - ip.width - gap
        if (w >= need) {
            // As a Row: the lines fill the width left by the icons and an 8 dp gap; both centred vertically.
            val tp = t.measure(Constraints(minWidth = w, maxWidth = w, maxHeight = c.maxHeight))
            val h = maxOf(tp.height, ip.height, c.minHeight)
            layout(c.maxWidth, h) { tp.placeRelative(0, ((h - tp.height) / 2f).roundToInt()); ip.placeRelative(w + gap, ((h - ip.height) / 2f).roundToInt()) }
        } else {
            val tp = t.measure(c.copy(minWidth = 0, minHeight = 0))
            val top = tp.height + 4.dp.roundToPx()
            layout(c.maxWidth, maxOf(top + ip.height, c.minHeight)) { tp.placeRelative(0, 0); ip.placeRelative(0, top) }
        }
    }
}

/**
 * Buttons in a row, in the order given, at the start (or at the [end]). When they do not all fit whole, they stack
 * instead, the last (primary) button on top, so no label breaks inside a word.
 */
@Composable
internal fun ButtonRow(modifier: Modifier = Modifier, end: Boolean = false, content: @Composable () -> Unit) {
    Layout(content, modifier) { ms, c ->
        val gap = 8.dp.roundToPx()
        val fits = ms.sumOf { it.maxIntrinsicWidth(c.maxHeight) } + gap * (ms.size - 1).coerceAtLeast(0) <= c.maxWidth
        if (fits) {
            // As a Row with spacedBy(8.dp): each button measured in the space left, top aligned.
            var left = c.maxWidth
            val ps = ms.map { m -> m.measure(Constraints(maxWidth = left.coerceAtLeast(0), maxHeight = c.maxHeight)).also { left -= it.width + gap } }
            val sum = ps.sumOf { it.width } + gap * (ps.size - 1).coerceAtLeast(0)
            val w = maxOf(sum, c.minWidth)
            layout(w, maxOf(ps.maxOfOrNull { it.height } ?: 0, c.minHeight)) {
                var x = if (end) w - sum else 0
                for (p in ps) { p.placeRelative(x, 0); x += p.width + gap }
            }
        } else {
            val ps = ms.reversed().map { it.measure(c.copy(minWidth = 0, minHeight = 0)) }
            val w = maxOf(ps.maxOf { it.width }, c.minWidth)
            layout(w, maxOf(ps.sumOf { it.height } + gap * (ps.size - 1), c.minHeight)) {
                var y = 0
                for (p in ps) { p.placeRelative(if (end) w - p.width else 0, y); y += p.height + gap }
            }
        }
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

/** Pairing card: header, fingerprint plate with Deny / Approve, or the other pairing states; footer with Cancel pairing request and the timeout. */
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
        // Bottom padding as wide as the gap above the footer, so Cancel pairing request does not sit on the border.
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
                Text(UiText.waitingCodesMatch(x), style = body, color = cs.onSurfaceVariant)
                WaitingSendAgain(vm, p, now)
            }
            row.state == PairState.SHOWN -> {
                FingerprintPlate(row.fingerprint.orEmpty(), x)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = { vm.deny(p.id) }, Modifier.weight(1f).heightIn(min = 48.dp), enabled = "deny:${p.id}" !in running,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = cs.error),
                        border = androidx.compose.foundation.BorderStroke(1.dp, cs.error)) { Text("Codes differ") }
                    TonalGreenButton(onClick = { vm.approve(p.id) }, text = "Codes match", modifier = Modifier.weight(1f),
                        enabled = "approve:${p.id}" !in running)
                }
            }
            prompted -> {
                Text("A new device wants to pair.", style = body, color = cs.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                GreenButton(onClick = { vm.reply(p.id) }, text = "Reply", icon = null, modifier = Modifier.fillMaxWidth())
            }
            row.role == PairRole.X -> Text(UiText.repliedWaiting(x), style = body, color = cs.onSurfaceVariant)
            else -> {
                Text(UiText.waitingReply(x), style = body, color = cs.onSurfaceVariant)
                when (PairingEngine.hint(row, p, now)) {
                    PairDecide.Hint.STILL_HOLDS -> Text(UiText.stillHolds(x), style = body, color = cs.onSurfaceVariant)
                    PairDecide.Hint.NO_REPLY_YET -> Text(UiText.noReplyYet(x), style = body, color = cs.onSurfaceVariant)
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
        PairingFooter("Times out in " + Countdown.format(row.startedAt, now)) { vm.cancelPairing(p.id) }
    }
}

/** Arrangement.SpaceBetween that keeps at least [gap] between items, so a FlowRow wraps an item instead of placing it flush. */
private class SpaceBetweenMin(gap: Dp) : Arrangement.Horizontal {
    override val spacing = gap
    override fun Density.arrange(totalSize: Int, sizes: IntArray, layoutDirection: LayoutDirection, outPositions: IntArray) =
        with(Arrangement.SpaceBetween) { arrange(totalSize, sizes, layoutDirection, outPositions) }
}

/** Pairing card footer: Cancel pairing request at the left, the timeout at the right, or under the button when both do not fit. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PairingFooter(timeout: String, onCancel: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    FlowRow(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = SpaceBetweenMin(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onCancel, Modifier.heightIn(min = 48.dp)) { Text("Cancel pairing request") }
        Row(Modifier.align(Alignment.CenterVertically), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(PaIcons.Schedule, null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
            Text(timeout, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
}

/** Plate with the caps label and four mono cells; read as one element, character by character. */
@Composable
internal fun FingerprintPlate(code: String, x: String) {
    val ex = LocalPaExtra.current
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(ex.plate).padding(horizontal = 12.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.clearAndSetSemantics {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_notify), null, Modifier.size(13.dp), tint = cs.primary)
            Text("Pairing fingerprint".uppercase(), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        val shape = RoundedCornerShape(14.dp)
        val sem = Modifier.clearAndSetSemantics { contentDescription = UiText.fingerprintLabel(code) }
        // The cells always share one row: each cell narrows to fit the width, and the glyph follows the cell,
        // so a large font size makes it no bigger than the cell holds.
        BoxWithConstraints(sem.fillMaxWidth(), contentAlignment = Alignment.Center) {
            val gap = 10.dp
            val w = ((maxWidth - gap * (code.length - 1).coerceAtLeast(0)) / code.length.coerceAtLeast(1)).coerceIn(0.dp, 64.dp)
            val glyph = minOf(with(LocalDensity.current) { FingerprintText.fontSize.toDp() }, w * 0.625f)
            val style = with(LocalDensity.current) { FingerprintText.copy(fontSize = glyph.toSp(), lineHeight = (glyph * 1.2f).toSp()) }
            Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (c in code) Box(Modifier.width(w).heightIn(min = w * 76f / 64f).clip(shape).background(ex.fpCell).border(1.dp, cs.outline, shape), Alignment.Center) {
                    Text(c.toString(), style = style, color = cs.onSurface, maxLines = 1) // one ink for every cell
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text("Verify that \"$x\" shows this same code.", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

/** A checkable menu row: the tick is the state; greyed while disabled. */
@Composable
private fun CheckItem(text: String, checked: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(text) }, onClick = onClick, enabled = enabled,
        modifier = Modifier.semantics { stateDescription = if (checked) "On" else "Off" },
        trailingIcon = { Checkbox(checked, null, enabled = enabled) })
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

/** Send: field, counter and "Send as URL" (a phone number: its caption and "Send as text" above it), then the device chips just above the green Send pinned at the bottom (above the keyboard). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SendScreen(vm: AppViewModel, initial: String = "", preselect: String? = null, title: String? = null, inDialog: Boolean = false, onPair: () -> Unit = {}, onSent: (AppViewModel.SendResult) -> Unit = {}) {
    val shots = BuildConfig.SCREENSHOT_MODE && ScreenshotMode.on && title != null
    var text by rememberSaveable { mutableStateOf(if (shots) ScreenshotMode.sendText else initial) }
    var asText by rememberSaveable { mutableStateOf(false) }
    // Count with the text, so a repeat of the same result still shows a snackbar.
    var result by remember { mutableStateOf<Pair<Int, String>?>(null) }
    val peers by vm.peers.collectAsState()
    val me by vm.self.collectAsState()
    val all = vm.allPeers()
    // Saved, so the chosen devices stay chosen through a rotation.
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
            // Suspends, never blocks the main thread. A chip tapped meanwhile is not added twice.
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
    // The app's one snackbar; the share sheet has none, so it keeps its own.
    val shared = LocalSnackbar.current
    val snack = shared ?: remember { SnackbarHostState() }
    LaunchedEffect(result) { result?.let { snack.showSnackbar(UiText.brief(it.second)) } }
    // A result about the last send goes away once the message or the chosen devices change.
    DismissSnackbarOnChange(snack, text to picked.toList())
    val keyboardUp = WindowInsets.isImeVisible
    // With the keyboard up the field keeps at least 2 lines: the counter and "Send as URL" row gives way,
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
    // the page scrolls instead, so the field stays usable and every chip can be reached.
    val scrolls = sendScrolls(areaPx, chipsPx, if (extras) extrasPx else 0, if (keyboardUp) twoLinesPx else linesPx(4))
    // In the share sheet dialog it is as tall as its content, up to the dialog's limit.
    val fill = if (inDialog) Modifier.fillMaxWidth() else Modifier.fillMaxSize()
    Box(fill.imePadding()) {
        Column(fill) {
            title?.let { PaTopBar(it) }
            // Chips and Send keep their space, and the field gets what is left; when that is too little, the page scrolls.
            Column(Modifier.weight(1f, fill = !inDialog).fillMaxWidth().onSizeChanged { areaPx = it.height }
                .then(if (scrolls) Modifier.verticalScroll(rememberScrollState()) else Modifier)) {
                // The field and its caption row take the free space, so the chips sit at the bottom, just above Send.
                Column(if (scrolls) Modifier else Modifier.weight(1f, fill = !inDialog)) {
                    // The field starts at 4 lines and grows with its text up to the free space, then scrolls inside;
                    // with the keyboard up it shrinks first, to 2 lines while the chips still fit.
                    OutlinedTextField(text, { asText = SendAsUrl.afterEdit(text, it, asText); text = it }, modifier = Modifier.rowPad.fillMaxWidth().then(if (scrolls) Modifier else Modifier.weight(1f, fill = false))
                        .padding(top = if (title == null) 16.dp else 0.dp), minLines = 4, label = { Text("Message") },
                        shape = RoundedCornerShape(12.dp),
                        colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = ex.tile, unfocusedContainerColor = ex.tile,
                            focusedBorderColor = cs.primary, unfocusedBorderColor = cs.outline))
                    val counter = UiText.showCounter(bytes)
                    if (extras) Column(Modifier.onSizeChanged { extrasPx = it.height }) {
                        // The type caption and the counter at the left; "Send as text" at the far right, only for a detected URL or phone number.
                        Row(Modifier.padding(start = 32.dp, end = 16.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Box(Modifier.align(Alignment.CenterVertically)) { TypeCaption(SendAsUrl.effective(text, asText)) }
                                if (counter) Text(UiText.counter(bytes), Modifier.align(Alignment.CenterVertically), style = MaterialTheme.typography.bodySmall, color = cs.error)
                            }
                            if (SendAsUrl.offersText(text)) Row(Modifier.heightIn(min = 40.dp).toggleable(asText, role = Role.Checkbox) { asText = it },
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
                }
                val chips = UiText.sortedByName(others(peers, me?.id).filter { it.pinned && !it.hidden }, ::label)
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
                                if (!ok) { vm.tapGreyed(); scope.launch { snack.showSnackbar(UiText.brief(UiText.greyedChip(label(p), UiText.status(p).second))) } }
                                else if (p.id in picked) picked.remove(p.id) else picked.add(p.id)
                            }
                        }
                    }
                }
            }
            val running by vm.running.collectAsState()
            GreenButton(onClick = {
                // One send per tap: a second tap while the first is on its way does not send twice.
                if (AppViewModel.claim(vm.running, "send")) {
                    scope.launch { vm.g.settings.saveSendTo(sendTo) }
                    scope.launch {
                        // A send that reached a device leaves this screen, so only a failure shows here.
                        try {
                            val r = vm.send(sendTo, text, asText)
                            if (r.ok) asText = false else result = ((result?.first ?: 0) + 1) to r.text
                            onSent(r)
                        }
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

/** The main screen's one snackbar for transient messages; null outside it. */
internal val LocalSnackbar = androidx.compose.runtime.staticCompositionLocalOf<SnackbarHostState?> { null }

/** Hides the snackbar on screen when [key] changes, so a note about an earlier action does not sit over new content. */
@Composable
internal fun DismissSnackbarOnChange(state: SnackbarHostState, key: Any?) {
    LaunchedEffect(key) { state.currentSnackbarData?.dismiss() }
}

/** Detected type as quiet supporting text, not a control: "Will be sent as URL". */
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
        modifier = Modifier.alpha(if (enabled) 1f else 0.5f).semantics { if (status != null) contentDescription = UiText.chipLabel(name, status) },
        label = { Text(name, Modifier.widthIn(max = 240.dp), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingIcon = { Icon(if (selected && enabled) PaIcons.Check else icon, null, Modifier.size(18.dp)) },
        colors = FilterChipDefaults.filterChipColors(containerColor = LocalPaExtra.current.tile, selectedContainerColor = softGreenFill(LocalPaExtra.current.dark),
            selectedLabelColor = softGreenText(LocalPaExtra.current.dark), selectedLeadingIconColor = softGreenText(LocalPaExtra.current.dark)),
        border = FilterChipDefaults.filterChipBorder(enabled = true, selected = selected && enabled, borderColor = cs.outline, selectedBorderColor = Color.Transparent))
}

/** History: filter chips, day groups, newest first, unread rows bold, expanded row actions. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HistoryScreen(vm: AppViewModel, onPair: () -> Unit = {}, onSend: () -> Unit = {}) {
    val stored by vm.history.collectAsState()
    val rows = remember(stored) { withoutStatus(stored) }
    val peers by vm.peers.collectAsState()
    val me by vm.self.collectAsState()
    var chip by rememberSaveable(stateSaver = chipSaver) { mutableStateOf<HistoryFilter.Chip>(HistoryFilter.Chip.All) }
    var dirs by rememberSaveable { mutableStateOf(listOf<String>()) }
    var open by rememberSaveable { mutableStateOf<Long?>(null) }
    // the ids checked in multi-select; empty means the mode is off. Leaving the screen ends it.
    var picked by rememberSaveable { mutableStateOf(listOf<Long>()) }
    var confirmDeleteSel by rememberSaveable { mutableStateOf(false) }
    androidx.activity.compose.BackHandler(enabled = picked.isNotEmpty()) { picked = emptyList() }
    DisposableEffect(Unit) { onDispose { picked = emptyList() } }
    fun nameOf(id: String) = peers.firstOrNull { it.id == id }?.let { (it.name ?: label(it)) + if (it.removed) " (removed)" else "" } ?: "(removed)"
    val view = remember(rows, peers, chip, dirs) { historyView(rows, chip, dirs, ::nameOf) }
    val eff = view.eff
    val ex = LocalPaExtra.current
    val now = System.currentTimeMillis()
    val flashId by vm.flashRow.collectAsState()
    val state = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val glow = remember { Animatable(0f) }
    var glowId by remember { mutableStateOf<Long?>(null) }
    Column(Modifier.fillMaxSize()) {
        PaTopBar("History")
        if (rows.isEmpty()) {
            // Scrolls when landscape or a large font makes it taller than the screen.
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                val cta = UiText.historyCta(me != null, others(peers, me?.id).count { it.pinned && !it.removed })
                EmptyState({ MessagesIllustration() }, "No messages yet",
                    "Everything you send or receive shows up here. Share a URL from any app to send it to your devices.", top = 110.dp,
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
            for (c in view.chips) {
                val t = when (c) { HistoryFilter.Chip.All -> "All"; HistoryFilter.Chip.Unknown -> "Unknown"; is HistoryFilter.Chip.PeerChip -> c.name }
                val on = if (c == HistoryFilter.Chip.All) allChipOn(eff, dirs) else eff == c
                PaChip(on, t) { chip = c; if (c == HistoryFilter.Chip.All) dirs = emptyList() }
            }
            PaChip("SENT" in dirs, "Sent") { dirs = toggleDirection(dirs, "SENT") }
            PaChip("RECEIVED" in dirs, "Received") { dirs = toggleDirection(dirs, "RECEIVED") }
        }
        val shown = view.shown
        // Rows that were deleted or filtered away leave the selection; none left ends the mode.
        val shownIds = view.shownIds
        if (picked.any { it !in shownIds }) picked = picked.filter { it in shownIds }
        if (picked.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.End) {
            FilledTonalButton(onClick = { confirmDeleteSel = true }, Modifier.heightIn(min = 48.dp),
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer)) { Text(deleteSelectedLabel(picked.size)) }
        }
        if (confirmDeleteSel && picked.isNotEmpty()) AlertDialog(onDismissRequest = { confirmDeleteSel = false },
            title = { Text(deleteSelectedTitle(picked.size)) }, text = { Text("This deletes the selected messages from this device.") },
            confirmButton = { TextButton(onClick = { vm.deleteHistory(picked); picked = emptyList(); confirmDeleteSel = false }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDeleteSel = false }) { Text("Cancel") } })
        val days = view.days
        // A row just sent from the Send tab: scrolled to and flashed once; a filter that hides it is cleared.
        LaunchedEffect(flashId, shown) {
            val id = flashId ?: return@LaunchedEffect
            if (rows.none { it.id == id }) return@LaunchedEffect // not loaded yet; runs again when it is
            if (shown.none { it.id == id }) { chip = HistoryFilter.Chip.All; dirs = emptyList(); return@LaunchedEffect }
            vm.flashRow.value = null
            val idx = historyItemIndex(days.values.map { g -> g.map { it.id } }, id)
            scope.launch {
                state.scrollToItem(maxOf(0, idx - 1))
                if (animationsOn(context)) { glowId = id; glow.snapTo(0f); glow.animateTo(1f, tween(150)); glow.animateTo(0f, tween(450)); glowId = null }
            }
        }
        LazyColumn(Modifier.weight(1f), state = state, contentPadding = PaddingValues(bottom = 16.dp)) {
            for ((day, group) in days) {
                item(key = "day-$day") {
                    val l = UiText.dayLabel(group.first().at, now)
                    Text(l.uppercase(), Modifier.padding(start = 32.dp, end = 16.dp, top = 20.dp, bottom = 8.dp).semantics { contentDescription = l; heading() },
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                itemsIndexed(group, key = { _, h -> h.id }) { i, h ->
                    val fill = if (open == h.id) ex.expandedRow else ex.tile
                    HistoryRow(vm, h, open == h.id, picked.isNotEmpty(), h.id in picked, { picked = toggleSelected(picked, h.id) }, ::nameOf,
                        Modifier.padding(top = if (i > 0) 2.dp else 0.dp).groupItem(i, group.size,
                            if (glowId == h.id) lerp(fill, MaterialTheme.colorScheme.secondaryContainer, glow.value) else fill)) { open = toggleOpenRow(open, h.id) }
                }
            }
        }
    }
}

/** What History shows: the chip in effect, the chips, the shown rows and their day groups. */
internal class HistoryView(
    val eff: HistoryFilter.Chip,
    val chips: List<HistoryFilter.Chip>,
    val shown: List<com.pusharmor.store.HistoryEntity>,
    val shownIds: Set<Long>,
    val days: Map<java.time.LocalDate, List<com.pusharmor.store.HistoryEntity>>,
)

/** The Sent and Received chips are independent toggles; with neither on, every direction shows. */
internal fun toggleDirection(dirs: List<String>, d: String): List<String> = if (d in dirs) dirs - d else dirs + d

/** The All chip is on when no device chip and neither direction is chosen; so choosing Sent or Received turns it off and clearing both turns it on. */
internal fun allChipOn(eff: HistoryFilter.Chip, dirs: List<String>): Boolean = eff == HistoryFilter.Chip.All && dirs.isEmpty()

/** Computes [HistoryView] once per change of rows, devices, or filters (the screen remembers it). */
internal fun historyView(rows: List<com.pusharmor.store.HistoryEntity>, chip: HistoryFilter.Chip, dirs: List<String>, nameOf: (String) -> String): HistoryView {
    val frows = rows.map { HistoryFilter.Row(it.peerId, it.direction == "RECEIVED") }
    val eff = HistoryFilter.effective(frows, chip)
    val shown = rows.filter { HistoryFilter.matches(HistoryFilter.Row(it.peerId, it.direction == "RECEIVED"), eff) && (dirs.isEmpty() || it.direction in dirs) }
    return HistoryView(eff, HistoryFilter.chips(frows, nameOf), shown, shown.map { it.id }.toSet(), shown.groupBy { UiText.day(it.at) })
}

/** Tapping the open History row closes it; tapping another opens that one. */
internal fun toggleOpenRow(open: Long?, id: Long): Long? = if (open == id) null else id

/** Multi-select: a long-press or tap toggles [id]; the mode is on while the list is not empty. */
internal fun toggleSelected(picked: List<Long>, id: Long): List<Long> = if (id in picked) picked - id else picked + id

/** "Delete 1 selected", "Delete 3 selected". */
internal fun deleteSelectedLabel(n: Int): String = "Delete $n selected"

/** The confirm title: "Delete 1 message?", "Delete 3 messages?". */
internal fun deleteSelectedTitle(n: Int): String = if (n == 1) "Delete 1 message?" else "Delete $n messages?"

/** LazyColumn index of History row [id], given the row ids of each day group under its day header. */
internal fun historyItemIndex(days: List<List<Long>>, id: Long): Int {
    var idx = 0
    for (g in days) {
        val i = g.indexOf(id)
        if (i >= 0) return idx + 1 + i
        idx += 1 + g.size
    }
    return 0
}

/** False when the system animator duration scale is 0 (animations off or reduced motion). */
internal fun animationsOn(ctx: android.content.Context): Boolean =
    android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

/** One row of filter chips that scrolls sideways, so a long device name never wraps Sent or Received onto a second line. */
@Composable
internal fun ChipRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val scroll = rememberScrollState()
    Row(modifier.fillMaxWidth().edgeFade(scroll).horizontalScroll(scroll).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** Saves the History device filter through a rotation. */
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

/** Device status rows (logged in, logged out, rejected): History lists none; those an older version stored stay in the database. */
private val STATUS_TYPES = setOf("logged_in", "logged_out", "denied")

internal fun withoutStatus(rows: List<com.pusharmor.store.HistoryEntity>) = rows.filter { it.type !in STATUS_TYPES }

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun HistoryRow(vm: AppViewModel, h: com.pusharmor.store.HistoryEntity, expanded: Boolean, selecting: Boolean, checked: Boolean,
                       onSelect: () -> Unit, nameOf: (String) -> String,
                       modifier: Modifier, onOpen: () -> Unit) {
    val context = LocalContext.current
    val cs = MaterialTheme.colorScheme
    val event = h.type !in CONTENT_TYPES
    val unread = !h.read && !event
    val who = h.peerId?.let { nameOf(it) } ?: if (h.direction == "SENT") UiText.sentTitle(h.toRow().results, nameOf) else "Unknown sender"
    val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(h.at))
    val body = when (h.type) {
        "unreadable" -> "PushArmor received a message it could not read" + if (h.count > 1) " (${h.count})" else ""
        "invalid" -> "Invalid message received" + if (h.count > 1) " (${h.count})" else ""
        "denied" -> "Rejected this device"
        "logged_out" -> "Logged out"
        "logged_in" -> "Logged in"
        else -> h.content.orEmpty()
    }
    // Unread: bold text, no dot, so the time column stays aligned (F32).
    val weight = if (unread) FontWeight.Bold else FontWeight.Normal
    Column(modifier.combinedClickable(role = Role.Button, onLongClick = onSelect) { if (selecting) onSelect() else { onOpen(); vm.markRead(h.id) } }
        .semantics {
            val st = listOfNotNull(if (unread) "Unread" else null, if (selecting) (if (checked) "Selected" else "Not selected") else h.content?.let { if (expanded) "Expanded" else "Collapsed" })
            if (st.isNotEmpty()) stateDescription = st.joinToString(", ")
        }) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            if (selecting) Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.align(Alignment.CenterVertically))
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
                    // A large font puts the time on its own line, so the text keeps the full width.
                    if (LocalDensity.current.fontScale >= 1.3f) {
                        Text(time, Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                        Text(body, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    } else Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(body, Modifier.weight(1f).padding(top = 10.dp), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        Text(time, Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                    if (h.peerId != null) Text(who,
                        style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(who, Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium, fontWeight = weight, color = cs.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(time, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                    val style = MaterialTheme.typography.bodyLarge.copy(fontWeight = weight)
                    val hc = h.content
                    when {
                        expanded && hc != null && messageKind(h.type, hc) == MessageKind.TEXT -> TextBox(hc, style)
                        expanded && hc != null -> SelectionContainer { Text(hc, style = style) }
                        h.type == "url" -> MiddleEllipsisText(body, style, Modifier.fillMaxWidth())
                        h.type == "tel" -> Text(body, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        else -> Text(body, style = style, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        val hc = h.content
        if (expanded && !selecting && hc != null) {
            val kind = messageKind(h.type, hc)
            var reading by rememberSaveable(h.id) { mutableStateOf(false) }
            val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
                if (uri != null) {
                    val err = runCatching { context.contentResolver.openOutputStream(uri)?.use { it.write(hc.toByteArray(Charsets.UTF_8)) } ?: throw java.io.IOException("no stream") }.exceptionOrNull()
                    vm.message.value = if (err == null) "Saved." else com.pusharmor.net.ErrorText.text(UiText.UNABLE_SAVE_MESSAGE, UiText.saveReason(err))
                }
            }
            if (reading) ReadDialog(hc) { reading = false }
            MessageActions {
                for (label in historyActionLabels(kind)) when (label) {
                    "View" -> MessageAction("View", PaIcons.Article) { reading = true }
                    "Copy" -> MessageAction("Copy", PaIcons.ContentCopy) {
                        vm.message.value = UiText.copyResult(com.pusharmor.app.notify.ActionActivity.copy(context, hc))
                    }
                    "Open" -> if (kind == MessageKind.URL) com.pusharmor.protocol.UrlCheck.parse(hc)?.let { u ->
                        MessageAction("Open", PaIcons.OpenInNew) { startOrToast(context, Intent(Intent.ACTION_VIEW, Uri.parse(u.href)).addCategory(Intent.CATEGORY_BROWSABLE)) { vm.message.value = it } }
                    } else MessageAction("Open", PaIcons.OpenInNew) { startOrToast(context, Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(hc))), NO_APP_DIAL) { vm.message.value = it } }
                    "Share" -> MessageAction("Share", PaIcons.Share) {
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, hc), null))
                    }
                    "Save" -> MessageAction("Save", PaIcons.Save) { saver.launch(messageFileName(h.at)) }
                }
            }
        }
    }
}

/** The opened text message: its first [TEXT_BOX_LINES] lines, in a box that scrolls when the text is longer. */
@Composable
private fun TextBox(text: String, style: androidx.compose.ui.text.TextStyle) {
    // From the font size: a large font scales sizes non-linearly, and the line height follows the font size, not the curve.
    val lineDp = with(LocalDensity.current) { style.fontSize.toDp() } * (style.lineHeight.value / style.fontSize.value)
    Box(Modifier.fillMaxWidth().heightIn(max = lineDp * TEXT_BOX_LINES).verticalScroll(rememberScrollState())) {
        SelectionContainer { Text(text, style = style) }
    }
}

/** Near-full-screen reader with only a close button; the text is selectable so part of it can be copied. */
@Composable
private fun ReadDialog(text: String, onClose: () -> Unit) {
    // The dialog sizes itself from the screen size, which on Android 15 includes the system bars, so a window
    // that fits them is clipped at the bottom. A window under the bars with the insets as padding is not.
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding().padding(12.dp), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
            Column {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    IconButton(onClick = onClose) { Icon(PaIcons.Close, "Close") }
                }
                Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp)) {
                    val base = MaterialTheme.typography.bodyLarge
                    SelectionContainer { Text(text, style = base.copy(fontSize = base.fontSize * 1.5f, lineHeight = base.lineHeight * 1.5f)) }
                }
            }
        }
    }
}

/** Outlined action chip (History Copy and Share; Settings Log out and Delete account); [error] paints it red. */
@Composable
private fun RowAction(text: String, icon: ImageVector, enabled: Boolean = true, error: Boolean = false, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    AssistChip(onClick = onClick, label = { Text(text) }, enabled = enabled,
        leadingIcon = { Icon(icon, null, Modifier.size(18.dp)) },
        colors = AssistChipDefaults.assistChipColors(containerColor = LocalPaExtra.current.tile, leadingIconContentColor = if (error) cs.error else cs.primary,
            labelColor = if (error) cs.error else cs.onSurface),
        border = AssistChipDefaults.assistChipBorder(enabled = enabled, borderColor = cs.outline))
}

/** Buttons per row when [n] buttons wrap and [fit] fit a row: the same number of rows, filled evenly (4 at 3 per row gives 2 and 2, not 3 and 1). */
internal fun balancedPerRow(n: Int, fit: Int): Int = if (n <= 0 || fit <= 0) 1 else (n + (n + fit - 1) / fit - 1) / ((n + fit - 1) / fit)

/** The actions of an opened History message: equal-width buttons in one row, or in equal-width rows when the widest does not fit. */
@Composable
internal fun MessageActions(content: @Composable () -> Unit) {
    Layout(content, Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) { ms, c ->
        val gap = 8.dp.roundToPx()
        val need = ms.maxOfOrNull { it.maxIntrinsicWidth(c.maxHeight) } ?: 0
        val perRow = balancedPerRow(ms.size, ((c.maxWidth + gap) / (need + gap)).coerceIn(1, ms.size.coerceAtLeast(1)))
        val w = ((c.maxWidth - (perRow - 1) * gap) / perRow).coerceAtLeast(0)
        val ps = ms.map { it.measure(Constraints(minWidth = w, maxWidth = w, maxHeight = c.maxHeight)) }
        val rows = ps.chunked(perRow)
        val heights = rows.map { r -> r.maxOf { it.height } }
        layout(c.maxWidth, heights.sum() + (rows.size - 1).coerceAtLeast(0) * gap) {
            var y = 0
            rows.forEachIndexed { i, r ->
                r.forEachIndexed { j, p -> p.placeRelative(j * (w + gap), y) }
                y += heights[i] + gap
            }
        }
    }
}

/** One History message action: the outlined chip look with less side padding, its icon and label centered. */
@Composable
internal fun MessageAction(text: String, icon: ImageVector, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(onClick = onClick, modifier = Modifier.semantics { role = Role.Button }, shape = AssistChipDefaults.shape,
        color = LocalPaExtra.current.tile, border = BorderStroke(1.dp, cs.outline)) {
        Row(Modifier.heightIn(min = 32.dp).padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(18.dp), tint = cs.primary)
            Text(text, style = MaterialTheme.typography.labelLarge, color = cs.onSurface, maxLines = 1, softWrap = false)
        }
    }
}

/** A plain settings row (no icon tile); [onClick] null makes it static text. */
@Composable
internal fun SettingRow(title: String, sub: String? = null, modifier: Modifier, color: Color = Color.Unspecified, value: String? = null,
                       valueColor: Color? = null, trailing: (@Composable () -> Unit)? = null, onClick: (() -> Unit)?) {
    Row(modifier.heightIn(min = 56.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
        .padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        // The current value sits on the right, like a switch or an icon.
        value?.let { Spacer(Modifier.width(16.dp)); Text(it, style = MaterialTheme.typography.bodyMedium, color = valueColor ?: MaterialTheme.colorScheme.onSurfaceVariant) }
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
    var getApp by rememberSaveable { mutableStateOf(false) }
    // Read again on each return to the app, so a UnifiedPush app installed meanwhile is offered.
    val tick = resumeTick()
    val google = vm.g.push.hasPlayServices
    val apps = remember(tick) { UnifiedPushSupport.distributors(context).map { it to UnifiedPushSupport.appName(context, it) } }
    val pushNow = pushCurrent(prefs?.get(Settings.K.PUSH_TYPE), google, remember(tick, prefs) { UnifiedPushSupport.saved(context) })
    fun pushName(o: String?): String = pushMethodName(o, apps)
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
                SettingRow("Theme", modifier = m, value = themePref.label) { pickTheme = true }
            })
            // Logged out: only what needs no account and no device.
            if (!signedIn) return@Column
            SectionHeader("Sending")
            GroupedList(listOf<@Composable (Modifier) -> Unit>(
                { m -> SwitchRow("Show an \"All\" button when choosing devices", b(Settings.K.SHOW_ALL, true), modifier = m.then(pad)) { vm.setPref(Settings.K.SHOW_ALL, it) } },
            ))
            SectionHeader("Notifications")
            GroupedList(buildList<@Composable (Modifier) -> Unit> {
                add { m ->
                    SettingRow("System notification settings", "Choose whether PushArmor can notify you, and set its sound, vibration, and pop-up style.",
                        modifier = m, trailing = external) {
                        safeStart(context, Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName))
                    }
                }
                add { m ->
                    SwitchRow("Allow message content in notifications", b(Settings.K.SHOW_CONTENT, true), sub = "When off, notifications show only \"New message\".",
                        modifier = m.then(pad)) { vm.setPref(Settings.K.SHOW_CONTENT, it) }
                }
                add { m ->
                    SwitchRow("Allow message content on lock screen", b(Settings.K.LOCK_SCREEN, true), enabled = b(Settings.K.SHOW_CONTENT, true),
                        sub = "When off, the lock screen shows only \"New message\".", modifier = m.then(pad)) { vm.setPref(Settings.K.LOCK_SCREEN, it) }
                }
                // Received messages: what a notification tap does.
                add { m ->
                    SwitchRow("Tapping a URL notification opens the URL", b(Settings.K.TAP_OPENS_LINK, true),
                        sub = "When off, tapping opens the message in PushArmor, so you can check the URL first.", modifier = m.then(pad)) { vm.setPref(Settings.K.TAP_OPENS_LINK, it) }
                }
                add { m ->
                    SettingRow("System lock screen settings", "Choose what Android shows on your lock screen for all apps, including PushArmor messages.",
                        modifier = m, trailing = external) {
                        try { context.startActivity(Intent("android.settings.NOTIFICATION_SETTINGS")) } catch (e: Exception) { }
                    }
                }
                add { m ->
                    SwitchRow("Allow sending messages to watch", b(Settings.K.WATCH, true), sub = "When off, nothing is sent to your watch.",
                        modifier = m.then(pad)) { vm.setPref(Settings.K.WATCH, it) }
                }
                add { m -> SettingRow("Push method", modifier = m, value = pushName(pushNow),
                    valueColor = if (pushName(pushNow) == UiText.PUSH_NONE_AVAILABLE) cs.error else null) { pickPush = true } }
            })
            SectionHeader("History")
            GroupedList(listOf<@Composable (Modifier) -> Unit>(
                { m -> SettingRow("Delete messages older than", modifier = m, value = UiText.days(days)) { pickDays = true } },
                { m -> SettingRow("Delete all history", modifier = m, color = cs.error) { confirmHistory = true } },
            ))
            SectionHeader("Account")
            me?.email?.let { email ->
                // Dim label, then the email on its own line; a long address ends in an ellipsis.
                GroupedList(listOf<@Composable (Modifier) -> Unit> { m ->
                    Column(m.heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text("Logged in as", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        Text(email, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (email.endsWith("@privaterelay.appleid.com")) Text(UiText.APPLE_RELAY_HINT,
                            style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    }
                })
            }
            // Wraps to two lines at a large font instead of squeezing both buttons; centred, Delete account on the left.
            FlowRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                RowAction("Delete account", PaIcons.Delete, error = true) { confirmDelete = true }
                RowAction("Log out", PaIcons.Logout, enabled = "logout" !in running) { vm.signOut(onSignedOut) }
                // Log out on a slow or missing connection: visible progress beside the buttons.
                if ("logout" in running) androidx.compose.material3.CircularProgressIndicator(Modifier.size(24.dp).align(Alignment.CenterVertically).semantics { contentDescription = "Logging out" })
            }
            // Tap copies just the number; the button role and label name the action for TalkBack.
            Text(UiText.version(BuildConfig.VERSION_NAME),
                Modifier.fillMaxWidth().heightIn(min = 48.dp).wrapContentHeight(Alignment.CenterVertically)
                    .semantics { contentDescription = UiText.COPY_VERSION }
                    .clickable(onClickLabel = UiText.COPY_VERSION, role = Role.Button) {
                        // Logged out, Settings has no snackbar, and the sign-in screens show vm.message as an error: a Toast.
                        val msg = UiText.copyResult(com.pusharmor.app.notify.ActionActivity.copy(context, BuildConfig.VERSION_NAME))
                        if (signedIn) vm.message.value = msg else toast(context, msg)
                    }.padding(horizontal = 16.dp, vertical = 12.dp),
                style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
    if (pickDays) ChoiceDialog("Delete messages older than", listOf(1, 7, 30, 90, 365), days, { UiText.days(it) }, onDismiss = { pickDays = false }) {
        vm.setPref(Settings.K.HISTORY_DAYS, it)
    }
    if (pickTheme) ChoiceDialog("Theme", ThemePref.entries, themePref, { it.label }, note = "Dark uses a true black background.",
        onDismiss = { pickTheme = false }) { vm.setTheme(it) }
    if (pickPush) ChoiceDialog("Push method", pushOptions(google, apps), pushNow ?: "", ::pushName, note = UiText.UNIFIEDPUSH_NOTE,
        extra = { TextButton(onClick = { getApp = true }) { Text(UiText.GET_PUSH_APP) } },
        onDismiss = { pickPush = false }) { if (it != pushNow) vm.choosePush(it) }
    if (getApp) GetPushAppDialog(vm) { getApp = false }
    if (confirmHistory) AlertDialog(onDismissRequest = { confirmHistory = false }, text = { Text("Delete all history?") },
        confirmButton = { TextButton(onClick = { vm.deleteAllHistory(); confirmHistory = false }) { Text("Delete") } },
        dismissButton = { TextButton(onClick = { confirmHistory = false }) { Text("Cancel") } })
    if (confirmDelete) DeleteAccountDialog(onConfirm = { confirmDelete = false; onDeleteAccount() }) { confirmDelete = false }
}

/**
 * Standard single-choice dialog: radio rows, each row the tap target; OK applies the choice, Cancel keeps the old one.
 * The choice is kept by its index, so it stays through a rotation.
 */
@Composable
internal fun <T> ChoiceDialog(title: String, options: List<T>, current: T, label: (T) -> String, note: String? = null,
                              extra: (@Composable () -> Unit)? = null, onDismiss: () -> Unit, onChoose: (T) -> Unit) {
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
                extra?.invoke()
            }
        },
        confirmButton = { TextButton(onClick = { options.getOrNull(picked)?.let(onChoose); onDismiss() }) { Text("OK") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

/** Delete account confirmation: a standard dialog with a title, a red Continue, and Cancel. */
@Composable
internal fun DeleteAccountDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Delete account") }, text = { Text(UiText.DELETE_CONFIRM) },
        confirmButton = {
            TextButton(onClick = onConfirm, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Continue") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
