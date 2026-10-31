package com.pusharmor.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings as SysSettings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.pusharmor.app.data.Settings
import com.pusharmor.app.session.Session
import com.pusharmor.app.ui.theme.BlockingState
import com.pusharmor.app.ui.theme.GreenButton
import com.pusharmor.app.ui.theme.LocalPaExtra
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.app.ui.theme.PushArmorTheme
import com.pusharmor.app.ui.theme.ThemePref

/** Single NavHost (section 8). */
class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        vm.boot(fromMain = true)
        if (shouldHandle(savedInstanceState != null, intent.flags)) handle(intent)
        setContent { AppTheme(vm) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { App(vm) } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        authExtras(intent)?.let { (t, e) -> vm.onAppLinkTicket(t, e) {} }
        ownExtras(intent)?.let { (peer, route) ->
            peer?.let { vm.highlight.value = it }
            route?.let { pendingRoute = it }
        }
    }

    companion object {
        /**
         * False for a recreate (rotation) and for a relaunch from Recents: both bring back the
         * original intent, whose route and ticket are already spent.
         */
        fun shouldHandle(restored: Boolean, flags: Int): Boolean =
            !restored && flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0

        /** Compose state, so a notification tap while the app is open recomposes and navigates (I401). */
        var pendingRoute by mutableStateOf<String?>(null)

        /** Non-exported alias of this activity; only [AuthLinkActivity] starts it (I298). */
        const val AUTH_ALIAS = "com.pusharmor.app.ui.AuthTicket"

        /** Non-exported alias of this activity; our own notification PendingIntents start it (I332). */
        const val OPEN_ALIAS = "com.pusharmor.app.ui.OpenFromNotice"

        val ROUTES = setOf("peers", "send", "history", "settings")

        /** Returns [route] only when it is a known destination. */
        fun safeRoute(route: String?): String? = route?.takeIf { it in ROUTES }

        /** Peer and route extras, honored only when the intent came through [OPEN_ALIAS]. */
        fun ownExtras(intent: Intent): Pair<String?, String?>? {
            if (intent.component?.className != OPEN_ALIAS) return null
            return intent.getStringExtra("peer") to safeRoute(intent.getStringExtra("route"))
        }

        /** Intent for our own notification taps and in-app jumps. */
        fun openIntent(ctx: android.content.Context, route: String): Intent =
            Intent().setClassName(ctx.packageName, OPEN_ALIAS).putExtra("route", route)

        /** Ticket and email extras, honored only when the intent came through [AUTH_ALIAS]. */
        fun authExtras(intent: Intent): Pair<String, String?>? {
            if (intent.component?.className != AUTH_ALIAS) return null
            val t = intent.getStringExtra("ticket") ?: return null
            return t to intent.getStringExtra("email")
        }
    }
}

/** PushArmorTheme driven by the Theme setting; also hands the choice to the system once it is loaded. */
@Composable
internal fun AppTheme(vm: AppViewModel, content: @Composable () -> Unit) {
    val prefs by vm.prefs.collectAsState()
    val pref = ThemePref.parse(prefs?.get(Settings.K.THEME))
    val ctx = androidx.compose.ui.platform.LocalContext.current
    if (prefs != null) androidx.compose.runtime.LaunchedEffect(pref) { ThemePref.applyToSystem(ctx, pref) }
    PushArmorTheme(dark = pref.isDark(androidx.compose.foundation.isSystemInDarkTheme()), content = content)
}

/** Q349: this version got HTTP 426, so nothing else works until the app is updated. */
@Composable
internal fun UpdateScreen(modifier: Modifier = Modifier) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    // Scrolls when landscape or a large font makes it taller than the screen (I529); centred otherwise.
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 32.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        com.pusharmor.app.ui.theme.IconTile(PaIcons.Info, size = 56.dp)
        androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 20.dp))
        Text(UPDATE_TITLE, style = MaterialTheme.typography.titleLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
        Text(UPDATE_BODY, style = MaterialTheme.typography.bodyLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 24.dp))
        GreenButton(onClick = {
            startOrToast(ctx, Intent(Intent.ACTION_VIEW, android.net.Uri.parse(UPDATE_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }, text = "Update", icon = null, modifier = Modifier.fillMaxWidth())
    }
}

internal const val UPDATE_TITLE = "Please update PushArmor"
internal const val UPDATE_BODY = "This version no longer works with the relay server. Update to keep sending and receiving."
internal const val UPDATE_URL = "https://pusharmor.com/download"

@Composable
private fun App(vm: AppViewModel) {
    val prefs by vm.prefs.collectAsState()
    if (prefs?.get(Settings.K.UPDATE_REQUIRED) == com.pusharmor.app.BuildConfig.VERSION_NAME) { UpdateScreen(Modifier.safeDrawingPadding()); return }
    val start by vm.start.collectAsState()
    val limit by vm.limit.collectAsState()
    val signInPurpose by vm.signInPurpose.collectAsState()
    val nav = rememberNavController()
    var deleting by rememberSaveable { mutableStateOf(false) }
    when (start) {
        null -> {
            Box(Modifier.fillMaxSize().safeDrawingPadding(), Alignment.Center) { CircularProgressIndicator() }
            return
        }
        Session.Start.KEYS_UNAVAILABLE -> {
            BlockingState(PaIcons.Info, Session.KEYS_UNAVAILABLE, Modifier.safeDrawingPadding()) {
                GreenButton(onClick = { vm.io { vm.g.session.selfRemoved(deleted = false, lostKeys = true); vm.boot() } }, text = "Log in again", icon = null)
            }
            return
        }
        else -> Unit
    }
    if (limit != null) { LimitScreen(vm) {}; return }
    val signedIn = start == Session.Start.READY
    if (!signedIn || deleting) {
        val purpose = if (deleting) "delete-account" else signInPurpose
        var email by rememberSaveable { mutableStateOf(false) }
        // Logged out: no bottom bar; a Settings button on the sign-in screens opens the settings that need no account (I612).
        var settings by rememberSaveable { mutableStateOf(false) }
        if (settings && !deleting) {
            val close = { settings = false }
            androidx.activity.compose.BackHandler(onBack = close)
            Box(Modifier.fillMaxSize().safeDrawingPadding()) { SettingsScreen(vm, onDeleteAccount = {}, onSignedOut = {}, onBack = close, signedIn = false) }
            return
        }
        val onSettings = if (deleting) null else ({ settings = true })
        // Each sign-in step starts with no message from the step before (I425).
        if (email) EmailScreen(vm, purpose, onBack = { vm.message.value = null; email = false }, onSettings = onSettings) { deleting = false; email = false }
        else WelcomeScreen(vm, purpose, onEmail = { vm.message.value = null; email = true }, onSettings = onSettings,
            onCancel = if (deleting) ({ vm.message.value = null; deleting = false }) else null) { deleting = false }
        return
    }
    PermissionGate {
        val back by nav.currentBackStackEntryAsState()
        val route = back?.destination?.route
        val pending = MainActivity.pendingRoute
        // Only a resumed activity takes the route: a relaunch (CLEAR_TASK or CLEAR_TOP) sets it while
        // the old, paused instance is still composing, and that one must not use it up.
        val resumed = LocalLifecycleOwner.current.lifecycle.currentStateAsState().value.isAtLeast(Lifecycle.State.RESUMED)
        // After NavHost has set the graph: navigating during the first composition throws (I399).
        androidx.compose.runtime.LaunchedEffect(back, pending, resumed) {
            if (resumed && back != null && pending != null) { MainActivity.pendingRoute = null; nav.navigate(pending) { launchSingleTop = true } }
        }
        val x = LocalPaExtra.current
        // The app's one place for transient messages (I603): above the bottom bar, and above the keyboard when it is up.
        // Taken as soon as it is set, so no screen finds an old one later (I426, I527); a new message replaces the one shown.
        val snack = remember { SnackbarHostState() }
        // One back step to Devices, then out: Back does not walk every visited tab (I478).
        fun tab(r: String) = nav.navigate(r) { popUpTo("peers") { saveState = true }; launchSingleTop = true; restoreState = true }
        androidx.compose.runtime.LaunchedEffect(Unit) {
            var shown: kotlinx.coroutines.Job? = null
            launch {
                vm.message.collect { m ->
                    if (m != null) { vm.message.value = null; shown?.cancel(); shown = launch { snack.showSnackbar(m, duration = SnackbarDuration.Short) } }
                }
            }
            // A send that reached a device: History, scrolled to the new row, and a 2 s note (I596).
            vm.sent.collect { r ->
                if (r != null) {
                    vm.sent.value = null
                    vm.flashRow.value = r.historyId
                    tab("history")
                    shown?.cancel(); shown = launch { kotlinx.coroutines.withTimeoutOrNull(SENT_SNACK_MS) { snack.showSnackbar(r.text) } }
                }
            }
        }
        // Send and History with no paired device: to Devices, which shows the first-pair steps (I611, I612).
        val pair = { tab("peers") }
        Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
            // Status bar strip: white in light (like the top app bar), so a heads-up reads against the page.
            Box(Modifier.fillMaxWidth().background(if (x.dark) MaterialTheme.colorScheme.background else x.tile)
                .windowInsetsTopHeight(WindowInsets.statusBars))
        }, bottomBar = {
            Column {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                NavigationBar(containerColor = x.tile, tonalElevation = 0.dp) {
                    for ((r, l, i) in NAV_TABS) {
                        NavigationBarItem(selected = route == r, onClick = { tab(r) },
                            icon = { Icon(i, null) }, label = { NavLabel(l) },
                            colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.secondaryContainer))
                    }
                }
            }
        }) { pad ->
            // Consumed, so the Send screen's imePadding does not count the bottom bar twice.
            Box(Modifier.padding(pad).consumeWindowInsets(pad)) {
            androidx.compose.runtime.CompositionLocalProvider(LocalSnackbar provides snack) {
            NavHost(nav, startDestination = "peers", modifier = Modifier.fillMaxSize()) {
                composable("peers") { PeersScreen(vm) }
                composable("send") { SendScreen(vm, title = "Send", onPair = pair) }
                composable("history") { HistoryScreen(vm, onPair = pair, onSend = { tab("send") }) { id -> vm.highlight.value = id; nav.navigate("peers") } }
                composable("settings") { SettingsScreen(vm, onDeleteAccount = { vm.message.value = null; deleting = true }, onSignedOut = {}) }
            }
            }
            // On Send it sits above the Send button (I596), on Devices above the Pair a new device button (I615).
            val clear = when (route) { "send" -> SEND_BUTTON_SPACE; "peers" -> FAB_SPACE; else -> 0.dp }
            SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).imePadding().padding(bottom = clear))
            }
        }
    }
}

/** How long the note after a send stays (I596). */
internal const val SENT_SNACK_MS = 2000L

/** Height of the Send screen's button with its padding, kept clear by the snackbar (I596). */
private val SEND_BUTTON_SPACE = 84.dp

/** Bottom bar tabs (route, label, icon), in the order of every client: Send, History, Devices, Settings (I608). */
internal val NAV_TABS = listOf(Triple("send", "Send", PaIcons.Send), Triple("history", "History", PaIcons.History),
    Triple("peers", "Devices", PaIcons.Devices), Triple("settings", "Settings", PaIcons.Settings))

/**
 * Bottom bar label. One line at any font size, never a mid-word break (I480). The label grows with the font only
 * up to 1.3x, so "Settings" still reads in full at font 2.0 on a 360 dp screen (I525); the icons stay as they are.
 */
@Composable
internal fun NavLabel(text: String) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(
        androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, minOf(d.fontScale, 1.3f))) {
        Text(text, maxLines = 1, softWrap = false, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
    }
}

/** Ticks on every ON_RESUME, so checks of system settings run again when the user comes back (I479). */
@Composable
internal fun resumeTick(): Int {
    val owner = LocalLifecycleOwner.current
    var n by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    androidx.compose.runtime.DisposableEffect(owner) {
        val o = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) n++ }
        owner.lifecycle.addObserver(o)
        onDispose { owner.lifecycle.removeObserver(o) }
    }
    return n
}

/** POST_NOTIFICATIONS on first open; explainer with retry; permanently denied -> app notification settings. */
@Composable
internal fun PermissionGate(content: @Composable () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    fun granted() = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    var ok by remember { mutableStateOf(granted()) }
    // Saved, so a rotation while the system dialog is up does not ask a second time (I522).
    var launched by rememberSaveable { mutableStateOf(false) }
    var asked by rememberSaveable { mutableStateOf(false) }
    var skipped by rememberSaveable { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok = it; asked = true }
    // Allowed or revoked in system settings meanwhile: checked again on each return to the app (I479).
    val tick = resumeTick()
    androidx.compose.runtime.LaunchedEffect(tick) { ok = granted() }
    if (ok || skipped) { content(); return }
    if (!launched) { androidx.compose.runtime.LaunchedEffect(Unit) { launched = true; launcher.launch(Manifest.permission.POST_NOTIFICATIONS) } }
    val activity = ctx as? android.app.Activity
    val permanent = asked && activity != null && !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
    BlockingState(PaIcons.NotificationsOff, "PushArmor shows each message as a notification. Allow notifications to receive messages. Also turn off \"Pause app activity if unused\" for PushArmor.",
        Modifier.safeDrawingPadding()) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            GreenButton(onClick = {
                if (permanent) ctx.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, ctx.packageName))
                else launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }, text = if (permanent) "Open notification settings" else "Allow notifications", icon = null, modifier = Modifier.fillMaxWidth())
            TextButton(onClick = { skipped = true }) { Text("Not now") }
        }
    }
}
