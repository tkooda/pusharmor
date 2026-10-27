package com.pusharmor.app.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.pusharmor.app.data.Settings
import com.pusharmor.app.notify.AppEffects
import kotlinx.coroutines.launch

/** Welcome / Sign-in: Google, Apple, Email (all three always offered). */
@Composable
fun WelcomeScreen(vm: AppViewModel, purpose: String, onEmail: () -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs by vm.prefs.collectAsState()
    val banner = prefs?.get(Settings.K.BANNER)?.takeIf { !it.startsWith("no_distributor") }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("PushArmor", style = MaterialTheme.typography.headlineMedium)
        when {
            banner != null -> Text(banner, color = MaterialTheme.colorScheme.error)
            purpose == "unpause" -> Text("Signed out. Sign in to resume")
            purpose == "delete-account" -> Text("Sign in to confirm deleting the account")
        }
        Button(onClick = {
            scope.launch {
                val token = if (vm.g.push.hasPlayServices) GoogleSignIn.idToken(context as Activity, vm.g.session.nonce(purpose)) else null
                if (token != null) vm.googleToken(token, purpose, onDone) else customTab(context, vm.oauthUrl("google", purpose))
            }
        }, Modifier.fillMaxWidth()) { Text("Sign in with Google") }
        Button(onClick = { customTab(context, vm.oauthUrl("apple", purpose)) }, Modifier.fillMaxWidth()) { Text("Sign in with Apple") }
        OutlinedButton(onClick = onEmail, Modifier.fillMaxWidth()) { Text("Sign in with email") }
        vm.message.collectAsState().value?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

fun customTab(context: android.content.Context, url: String) {
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}

/** Email: address -> Turnstile -> code entry. */
@Composable
fun EmailScreen(vm: AppViewModel, purpose: String, onDone: () -> Unit) {
    var email by remember { mutableStateOf("") }
    var stage by remember { mutableStateOf(0) } // 0 address, 1 turnstile, 2 code
    var requestToken by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val msg by vm.message.collectAsState()
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (stage) {
            0 -> {
                OutlinedTextField(email, { email = it }, label = { Text("Email address") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    if (email.any { it.code > 127 }) error = "Only email addresses with plain ASCII characters are supported."
                    else { error = null; stage = 1 }
                }) { Text("Next") }
            }
            1 -> TurnstileView { token ->
                scope.launch {
                    val rt = vm.emailStart(email, token, purpose)
                    if (rt != null) { requestToken = rt; stage = 2 } else stage = 0
                }
            }
            2 -> {
                Text("Enter the code sent to $email")
                OutlinedTextField(code, { v ->
                    // paste takes a standalone 6-char token; typing is cleaned as typed
                    code = if (v.length > code.length + 1) CodeInput.fromPaste(v) ?: CodeInput.clean(v) else CodeInput.clean(v)
                    if (code.length == 6) requestToken?.let { vm.emailVerify(it, code, purpose, onDone) }
                }, label = { Text("Code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
        }
        (error ?: msg)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** Turnstile host page in a WebView; the token comes back through a WebMessageListener for https://pusharmor.com only. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TurnstileView(onToken: (String) -> Unit) {
    val context = LocalContext.current
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Update Android System WebView")
            Button(onClick = {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")))
            }) { Text("Open Play Store") }
        }
        return
    }
    AndroidView(modifier = Modifier.fillMaxWidth().height(420.dp), factory = { ctx ->
        WebView(ctx).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            CookieManager.getInstance().setAcceptCookie(true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.isForMainFrame && !request.url.toString().startsWith("https://pusharmor.com/")
            }
            var done = false
            WebViewCompat.addWebMessageListener(this, "paTurnstile", setOf("https://pusharmor.com")) { view, msg, _, _, _ ->
                val token = msg.data ?: return@addWebMessageListener
                if (done) return@addWebMessageListener
                done = true
                // After the token is read, WebView storage and cookies are cleared.
                WebStorage.getInstance().deleteAllData()
                CookieManager.getInstance().removeAllCookies(null)
                view.post { onToken(token) }
            }
            loadUrl("https://pusharmor.com/turnstile")
        }
    })
}

/** Peer limit picker on 409: platform, created, approves, approved_by; nothing pre-ticked. */
@Composable
fun LimitScreen(vm: AppViewModel, onDone: () -> Unit) {
    val limit by vm.limit.collectAsState()
    val ticked = remember { mutableStateListOf<String>() }
    val l = limit ?: return
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("This account has 10 peers. Pick peers to remove.", style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.weight(1f)) {
            items(l.peers, key = { it.id }) { p ->
                Row {
                    Checkbox(p.id in ticked, { if (it) ticked.add(p.id) else ticked.remove(p.id) })
                    Column {
                        Text("${AppEffects.platformLabel(p.platform)}, added ${AppEffects.dateLabel(p.created)}")
                        Text("approves ${p.approves}, approved by ${p.approvedBy}" + (if (!p.reachable) ", unreachable" else "") + (if (p.paused) ", signed out" else ""))
                    }
                }
            }
        }
        vm.message.collectAsState().value?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.evict(ticked.toList(), onDone) }, enabled = ticked.isNotEmpty()) { Text("Remove and sign in") }
            TextButton(onClick = { vm.cancelLimit() }) { Text("Cancel") }
        }
        Spacer(Modifier.height(8.dp))
    }
}
