@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package com.pusharmor.app.ui

import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.ui.theme.PushArmorTheme
import com.pusharmor.store.HistoryEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.After
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.protocol.Peer
import org.junit.Test
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/** Devices: a tap on a paired device opens Send with only that device picked, and the saved choice stays. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class DeviceTapSendTest {
    // The screen runs on its own recomposer and frame clock, so frames do not depend on what earlier tests left behind.
    private val clock = BroadcastFrameClock()
    private val scope = CoroutineScope(Dispatchers.Main + clock)
    private val recomposer = Recomposer(scope.coroutineContext)

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    /** Frames of 16 ms, each with its state changes, recomposition, and layout, as on a device. */
    private fun frames(v: View, n: Int = 1) = repeat(n) {
        Snapshot.sendApplyNotifications()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
        clock.sendFrame(SystemClock.uptimeMillis() * 1_000_000)
        shadowOf(Looper.getMainLooper()).idle()
        roots(v).forEach { it.measureAndLayoutForTest() }
    }

    /** "Expanded" or "Collapsed" for the row holding [body]. */
    private fun state(v: View, body: String): String {
        var n: SemanticsNode? = nodes(v).first { text(it) == body }
        while (n != null && n.config.getOrNull(SemanticsProperties.StateDescription) == null) n = n.parent
        return n!!.config[SemanticsProperties.StateDescription].substringAfterLast(", ")
    }

    private val app get() = ApplicationProvider.getApplicationContext<PaApp>()
    private val laptop = "A".repeat(40)
    private val phone = "C".repeat(40)

    private fun peer(id: String, name: String): Peer {
        val k = SoftwareKeyOps.generate()
        return Peer(id = id, platform = "android", signPub = B64url.encode(k.signPub), encPub = B64url.encode(k.encPub),
            pairingId = ByteArray(8), approved = true, approveVerified = true, name = name)
    }

    @After fun done() = runBlocking(Dispatchers.IO) {
        app.graph.dao.deleteAllHistory()
        app.graph.store.wipeRegistration()
        (app as com.pusharmor.app.TestApp).fakeHttp = null
        app.graph.settings.clearKeepingOldId()
        com.pusharmor.app.FakeAndroidKeyStore.remove()
    }

    private fun show(until: String, content: @androidx.compose.runtime.Composable (AppViewModel) -> Unit, vmReady: (AppViewModel) -> Unit = {}): Pair<org.robolectric.android.controller.ActivityController<ComponentActivity>, View> {
        runBlocking(Dispatchers.IO) {
            app.graph.dao.deleteAllHistory()
            com.pusharmor.app.FakeAndroidKeyStore.install()
            app.graph.keysOrNull = com.pusharmor.app.keys.KeystoreKeyOps.createFresh()
            app.graph.dao.putSelf(com.pusharmor.store.SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
            app.graph.store.putPeer(peer(laptop, "Laptop"))
            app.graph.store.putPeer(peer(phone, "Phone"))
            app.graph.settings.saveSendTo(listOf(laptop, phone))
        }
        val vm = AppViewModel(app)
        vmReady(vm)
        scope.launch { recomposer.runRecomposeAndApplyChanges() }
        val c = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val view = ComposeView(c.get()).apply { setParentCompositionContext(recomposer) }
        c.get().setContentView(view)
        view.setContent { PushArmorTheme(dark = false) { content(vm) } }
        val v = c.get().window.decorView
        val end = System.currentTimeMillis() + 10_000
        while (nodes(v).none { text(it) == until } && System.currentTimeMillis() < end) { Thread.sleep(20); frames(v) }
        assertTrue(nodes(v).map(::text).toString(), nodes(v).any { text(it) == until })
        return c to v
    }

    private fun close(c: org.robolectric.android.controller.ActivityController<ComponentActivity>) {
        c.pause().stop().destroy()
        recomposer.cancel()
        scope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun saved() = runBlocking(Dispatchers.IO) { app.graph.settings.lastSendTo() }

    @Test fun tapOnAPairedDeviceAsksForSendWithIt() {
        var vmSeen: AppViewModel? = null
        var opened = 0
        val (c, v) = show("Phone", { vm -> PeersScreen(vm, onSend = { opened++ }) }) { vmSeen = it }
        // the card's click (as a screen reader activates it): its own button, which asks Send to open
        val card = generateSequence(nodes(v).first { text(it) == "Phone" }) { it.parent }
            .first { it.config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.OnClick) != null }
        assertEquals(androidx.compose.ui.semantics.Role.Button, card.config.getOrNull(SemanticsProperties.Role))
        card.config[androidx.compose.ui.semantics.SemanticsActions.OnClick].action!!.invoke()
        frames(v, 5)
        assertEquals(1, opened)
        assertEquals(phone, vmSeen!!.sendOneOff.value)
        close(c)
    }

    @Test fun sendPicksOnlyTheTappedDeviceAndKeepsTheSavedChoice() {
        val (c, v) = show("Send to \"Phone\"", { vm -> SendScreen(vm, title = "Send") }) { it.sendOneOff.value = phone }
        // the remembered choice of both devices is not applied over it
        frames(v, 30)
        assertTrue(nodes(v).map(::text).toString(), nodes(v).any { text(it) == "Send to \"Phone\"" })
        assertFalse(nodes(v).any { text(it) == "Send to 2 devices" })
        assertEquals("$laptop,$phone", saved())
        close(c)
    }

    /** The relay server answers every call with [code]; /v1/send reports [word] for the phone. */
    private fun answer(code: Int, word: String = "sent") {
        (app as com.pusharmor.app.TestApp).fakeHttp = okhttp3.Interceptor { chain ->
            val body = if (code == 200 && chain.request().url.encodedPath == "/v1/send") "{\"r\":{\"$phone\":\"$word\"}}" else "{}"
            okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(code).message("x")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }
    }

    /** Taps Send to "Phone" and waits for the send to end. */
    private fun sendOneOff(): Pair<org.robolectric.android.controller.ActivityController<ComponentActivity>, AppViewModel> {
        var vm: AppViewModel? = null
        val (c, v) = show("Send to \"Phone\"", { m -> SendScreen(m, initial = "hello", title = "Send") }) { vm = it; it.sendOneOff.value = phone }
        frames(v, 10)
        val button = generateSequence(nodes(v).first { text(it) == "Send to \"Phone\"" }) { it.parent }
            .first { it.config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.OnClick) != null }
        button.config[androidx.compose.ui.semantics.SemanticsActions.OnClick].action!!.invoke()
        val end = System.currentTimeMillis() + 15_000
        frames(v, 3)
        while (("send" in vm!!.running.value || vm!!.sendDone.value != null) && System.currentTimeMillis() < end) { Thread.sleep(20); frames(v) }
        frames(v, 10)
        return c to vm!!
    }

    @Test fun failedSendOfAOneOffPickKeepsTheSavedChoice() {
        answer(500)
        val (c, _) = sendOneOff()
        assertEquals("$laptop,$phone", saved())
        close(c)
    }

    @Test fun sendOfAOneOffPickThatReachesTheDeviceSavesIt() {
        answer(200)
        val (c, _) = sendOneOff()
        assertEquals(phone, saved())
        close(c)
    }

    @Test fun sendWithNoTapUsesTheSavedChoice() {
        val (c, v) = show("Send to 2 devices", { vm -> SendScreen(vm, title = "Send") })
        assertEquals("$laptop,$phone", saved())
        close(c)
    }
}
