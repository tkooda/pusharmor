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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import com.pusharmor.app.ui.theme.FingerprintText
import com.pusharmor.app.ui.theme.GreenButton
import com.pusharmor.app.ui.theme.LocalPaExtra
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.app.ui.theme.PaTopBar
import com.pusharmor.app.ui.theme.SignInHalo
import com.pusharmor.app.ui.theme.Wordmark
import com.pusharmor.app.ui.theme.groupItem
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
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
    val cs = MaterialTheme.colorScheme
    val x = LocalPaExtra.current
    // Fills the screen when there is room (the middle centers above the buttons) and scrolls when
    // landscape or a large font makes it taller; weight() cannot fill inside verticalScroll (I424).
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.SpaceBetween, horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(0.dp))
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            SignInHalo()
            Spacer(Modifier.height(8.dp))
            Wordmark(34.sp)
            Spacer(Modifier.height(12.dp))
            Text("Links and text from your devices, end to end encrypted.", Modifier.widthIn(max = 320.dp),
                style = MaterialTheme.typography.bodyLarge, color = cs.onSurfaceVariant, textAlign = TextAlign.Center)
            val status = when {
                banner != null -> null
                purpose == "unpause" -> "Signed out. Sign in to resume"
                purpose == "delete-account" -> "Sign in to confirm deleting the account"
                else -> null
            }
            banner?.let { Spacer(Modifier.height(12.dp)); Text(it, color = cs.error, textAlign = TextAlign.Center) }
            status?.let { Spacer(Modifier.height(12.dp)); Text(it, color = cs.onSurfaceVariant, textAlign = TextAlign.Center) }
        }
        Column(Modifier.fillMaxWidth()) {
        vm.message.collectAsState().value?.let { Text(it, Modifier.fillMaxWidth().padding(bottom = 12.dp), color = cs.error, textAlign = TextAlign.Center) }
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val g = if (x.dark) Triple(Color(0xFF131314), Color(0xFF8E918F), Color(0xFFE3E3E3)) else Triple(Color.White, Color(0xFF747775), Color(0xFF1F1F1F))
            OutlinedButton(onClick = {
                scope.launch {
                    val token = if (vm.g.push.hasPlayServices) GoogleSignIn.idToken(context as Activity, vm.g.session.nonce(purpose)) else null
                    if (token != null) vm.googleToken(token, purpose, onDone) else customTab(context, vm.oauthUrl("google", purpose))
                }
            }, Modifier.fillMaxWidth().heightIn(min = 48.dp), border = BorderStroke(1.dp, g.second),
                colors = ButtonDefaults.outlinedButtonColors(containerColor = g.first, contentColor = g.third)) {
                Icon(PaIcons.GoogleG, null, Modifier.size(20.dp), tint = Color.Unspecified); Spacer(Modifier.width(10.dp)); Text("Sign in with Google")
            }
            val a = if (x.dark) Color.White to Color.Black else Color.Black to Color.White
            Button(onClick = { customTab(context, vm.oauthUrl("apple", purpose)) }, Modifier.fillMaxWidth().heightIn(min = 48.dp),
                colors = ButtonDefaults.buttonColors(containerColor = a.first, contentColor = a.second)) {
                Icon(PaIcons.Apple, null, Modifier.size(18.dp)); Spacer(Modifier.width(10.dp)); Text("Sign in with Apple")
            }
            OutlinedButton(onClick = onEmail, Modifier.fillMaxWidth().heightIn(min = 48.dp), border = BorderStroke(1.dp, cs.outline),
                colors = ButtonDefaults.outlinedButtonColors(containerColor = x.tile)) {
                Icon(PaIcons.Mail, null, Modifier.size(18.dp)); Spacer(Modifier.width(10.dp)); Text("Sign in with email")
            }
            Text("Use the same account on every device you want to pair.", Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        }
    }
    }
}

fun customTab(context: android.content.Context, url: String) {
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}

/** Email: address -> Turnstile -> code entry. */
@Composable
fun EmailScreen(vm: AppViewModel, purpose: String, onBack: () -> Unit = {}, onDone: () -> Unit) {
    var email by remember { mutableStateOf("") }
    var stage by remember { mutableStateOf(0) } // 0 address, 1 turnstile, 2 code
    var requestToken by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val msg by vm.message.collectAsState()
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        PaTopBar("Sign in with email", navigationIcon = { IconButton(onClick = onBack) { Icon(PaIcons.ArrowBack, "Back") } })
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (stage) {
                0 -> {
                    OutlinedTextField(email, { email = it }, label = { Text("Email address") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
                    GreenButton(onClick = {
                        if (email.any { it.code > 127 }) error = "Only email addresses with plain ASCII characters are supported."
                        else { error = null; stage = 1 }
                    }, text = "Next", icon = null, modifier = Modifier.fillMaxWidth())
                }
                1 -> TurnstileView { token ->
                    scope.launch {
                        val rt = vm.emailStart(email, token, purpose)
                        if (rt != null) { requestToken = rt; stage = 2 } else stage = 0
                    }
                }
                2 -> {
                    Text("Enter the code sent to $email")
                    CodeCells(code) { v ->
                        // paste takes a standalone 6-char token; typing is cleaned as typed
                        code = if (v.length > code.length + 1) CodeInput.fromPaste(v) ?: CodeInput.clean(v) else CodeInput.clean(v)
                        if (code.length == 6) requestToken?.let { vm.emailVerify(it, code, purpose, onDone) }
                    }
                }
            }
            (error ?: msg)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** Six mono code cells over one text field; the field keeps the "Code" label for screen readers. */
@Composable
private fun CodeCells(code: String, onChange: (String) -> Unit) {
    val x = LocalPaExtra.current
    val cs = MaterialTheme.colorScheme
    BasicTextField(code, onChange, Modifier.fillMaxWidth().semantics { contentDescription = "Code" }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
        decorationBox = { inner ->
            Box {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                    for (i in 0 until 6) {
                        val shape = RoundedCornerShape(12.dp)
                        Box(Modifier.weight(1f, fill = false).widthIn(max = 52.dp).fillMaxWidth().heightIn(min = 60.dp).clip(shape).background(x.fpCell)
                            .border(if (i == code.length) 2.dp else 1.dp, if (i == code.length) cs.primary else cs.outline, shape), Alignment.Center) {
                            Text(code.getOrNull(i)?.toString() ?: "", style = FingerprintText.copy(fontSize = 28.sp, lineHeight = 34.sp), color = cs.onSurface)
                        }
                    }
                }
                // The real field stays composed (focus, IME, paste) but draws nothing.
                Box(Modifier.size(1.dp).alpha(0f)) { inner() }
            }
        })
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
    AndroidView(modifier = Modifier.fillMaxWidth().height(420.dp).clip(RoundedCornerShape(20.dp)).background(LocalPaExtra.current.tile), factory = { ctx ->
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
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Text("This account has 10 peers. Pick peers to remove.", Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 16.dp),
            style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.weight(1f)) {
            itemsIndexed(l.peers, key = { _, p -> p.id }) { i, p ->
                val on = p.id in ticked
                ListItem(
                    modifier = Modifier.padding(top = if (i > 0) 2.dp else 0.dp).groupItem(i, l.peers.size)
                        .toggleable(on, role = Role.Checkbox) { if (it) ticked.add(p.id) else ticked.remove(p.id) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    leadingContent = { Checkbox(on, null) },
                    headlineContent = { Text("${AppEffects.platformLabel(p.platform)}, added ${AppEffects.dateLabel(p.created)}") },
                    supportingContent = {
                        Text("approves ${p.approves}, approved by ${p.approvedBy}" + (if (!p.reachable) ", unreachable" else "") + (if (p.paused) ", signed out" else ""))
                    },
                )
            }
        }
        vm.message.collectAsState().value?.let { Text(it, Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error) }
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { vm.cancelLimit() }) { Text("Cancel") }
            GreenButton(onClick = { vm.evict(ticked.toList(), onDone) }, text = "Remove and sign in", icon = null, enabled = ticked.isNotEmpty())
        }
    }
}
