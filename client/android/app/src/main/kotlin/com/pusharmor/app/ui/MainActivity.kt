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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.consumeWindowInsets
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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

@Composable
private fun App(vm: AppViewModel) {
    val start by vm.start.collectAsState()
    val limit by vm.limit.collectAsState()
    val signInPurpose by vm.signInPurpose.collectAsState()
    val nav = rememberNavController()
    var deleting by remember { mutableStateOf(false) }
    when (start) {
        null -> {
            Box(Modifier.fillMaxSize().safeDrawingPadding(), Alignment.Center) { CircularProgressIndicator() }
            return
        }
        Session.Start.KEYS_UNAVAILABLE -> {
            BlockingState(PaIcons.Info, Session.KEYS_UNAVAILABLE, Modifier.safeDrawingPadding()) {
                GreenButton(onClick = { vm.io { vm.g.session.selfRemoved(deleted = false, lostKeys = true); vm.boot() } }, text = "Sign in again", icon = null)
            }
            return
        }
        else -> Unit
    }
    if (limit != null) { LimitScreen(vm) {}; return }
    val signedIn = start == Session.Start.READY
    if (!signedIn || deleting) {
        val purpose = if (deleting) "delete-account" else signInPurpose
        var email by remember { mutableStateOf(false) }
        // Each sign-in step starts with no message from the step before (I425).
        if (email) EmailScreen(vm, purpose, onBack = { vm.message.value = null; email = false }) { deleting = false; email = false }
        else WelcomeScreen(vm, purpose, onEmail = { vm.message.value = null; email = true }) { deleting = false }
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
        Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
            // Status bar strip: white in light (like the top app bar), so a heads-up reads against the page.
            Box(Modifier.fillMaxWidth().background(if (x.dark) MaterialTheme.colorScheme.background else x.tile)
                .windowInsetsTopHeight(WindowInsets.statusBars))
        }, bottomBar = {
            Column {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                NavigationBar(containerColor = x.tile, tonalElevation = 0.dp) {
                    for ((r, l, i) in listOf(Triple("peers", "Devices", PaIcons.Devices), Triple("send", "Send", PaIcons.Send),
                        Triple("history", "History", PaIcons.History), Triple("settings", "Settings", PaIcons.Settings))) {
                        NavigationBarItem(selected = route == r, onClick = { nav.navigate(r) { launchSingleTop = true } },
                            icon = { Icon(i, null) }, label = { Text(l) },
                            colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.secondaryContainer))
                    }
                }
            }
        }) { pad ->
            // Consumed, so the Send screen's imePadding does not count the bottom bar twice.
            NavHost(nav, startDestination = "peers", modifier = Modifier.padding(pad).consumeWindowInsets(pad)) {
                composable("peers") { PeersScreen(vm) }
                composable("send") { SendScreen(vm, title = "Send") }
                composable("history") { HistoryScreen(vm) { id -> vm.highlight.value = id; nav.navigate("peers") } }
                composable("settings") { SettingsScreen(vm, onDeleteAccount = { vm.message.value = null; deleting = true }, onSignedOut = {}) }
            }
        }
    }
}

/** POST_NOTIFICATIONS on first open; explainer with retry; permanently denied -> app notification settings. */
@Composable
private fun PermissionGate(content: @Composable () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    fun granted() = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    var ok by remember { mutableStateOf(granted()) }
    var asked by remember { mutableStateOf(false) }
    var skipped by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok = it; asked = true }
    if (ok || skipped) { content(); return }
    if (!asked) { androidx.compose.runtime.LaunchedEffect(Unit) { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) } }
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
