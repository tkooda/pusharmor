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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.pusharmor.app.session.Session

/** Single NavHost (section 8). */
class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vm.boot(fromMain = true)
        // A recreate (rotation) brings back the same intent: its route and ticket are already spent.
        if (savedInstanceState == null) handle(intent)
        setContent { MaterialTheme { App(vm) } }
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

@Composable
private fun App(vm: AppViewModel) {
    val start by vm.start.collectAsState()
    val limit by vm.limit.collectAsState()
    val signInPurpose by vm.signInPurpose.collectAsState()
    val nav = rememberNavController()
    var deleting by remember { mutableStateOf(false) }
    when (start) {
        null -> { Text("PushArmor"); return }
        Session.Start.KEYS_UNAVAILABLE -> {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(Session.KEYS_UNAVAILABLE)
                Button(onClick = { vm.io { vm.g.session.selfRemoved(deleted = false, lostKeys = true); vm.boot() } }) { Text("Sign in again") }
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
        if (email) EmailScreen(vm, purpose) { deleting = false; email = false }
        else WelcomeScreen(vm, purpose, onEmail = { email = true }) { deleting = false }
        return
    }
    PermissionGate {
        val back by nav.currentBackStackEntryAsState()
        val route = back?.destination?.route
        val pending = MainActivity.pendingRoute
        // After NavHost has set the graph: navigating during the first composition throws (I399).
        androidx.compose.runtime.LaunchedEffect(back, pending) {
            if (back != null && pending != null) { MainActivity.pendingRoute = null; nav.navigate(pending) { launchSingleTop = true } }
        }
        Scaffold(bottomBar = {
            NavigationBar {
                for ((r, l) in listOf("peers" to "Peers", "send" to "Send", "history" to "History", "settings" to "Settings")) {
                    NavigationBarItem(selected = route == r, onClick = { nav.navigate(r) { launchSingleTop = true } }, icon = {}, label = { Text(l) })
                }
            }
        }) { pad ->
            NavHost(nav, startDestination = "peers", modifier = Modifier.padding(pad)) {
                composable("peers") { PeersScreen(vm) }
                composable("send") { SendScreen(vm) }
                composable("history") { HistoryScreen(vm) { id -> vm.highlight.value = id; nav.navigate("peers") } }
                composable("settings") { SettingsScreen(vm, onDeleteAccount = { deleting = true }, onSignedOut = {}) }
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
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("PushArmor shows each message as a notification. Allow notifications to receive messages. Also turn off \"Pause app activity if unused\" for PushArmor.")
        val activity = ctx as? android.app.Activity
        val permanent = asked && activity != null && !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        Button(onClick = {
            if (permanent) ctx.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, ctx.packageName))
            else launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }) { Text(if (permanent) "Open notification settings" else "Allow notifications") }
        Button(onClick = { skipped = true }) { Text("Not now") }
    }
}
