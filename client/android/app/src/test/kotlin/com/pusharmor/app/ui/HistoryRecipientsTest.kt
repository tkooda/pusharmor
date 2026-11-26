@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package com.pusharmor.app.ui

import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
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
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/** History: the Recipients line of a send to 2 or more devices, and the text of a filter with no match. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class HistoryRecipientsTest {
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

    /** One finger tap on [n]: down, a small move, up, sent through the window like a real touch. */
    private fun tap(v: View, n: SemanticsNode) {
        val r = n.boundsInWindow
        val x = (r.left + r.right) / 2; val y = (r.top + r.bottom) / 2
        val t = SystemClock.uptimeMillis()
        v.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0))
        frames(v, 5)
        v.dispatchTouchEvent(MotionEvent.obtain(t, t + 80, MotionEvent.ACTION_MOVE, x + 1, y + 1, 0))
        v.dispatchTouchEvent(MotionEvent.obtain(t, t + 80, MotionEvent.ACTION_UP, x + 1, y + 1, 0))
        // Past the double-tap timeout, so a held-back tap would have run by now.
        frames(v, 40)
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
    }

    private fun show(rows: List<HistoryEntity>, until: String): Pair<org.robolectric.android.controller.ActivityController<ComponentActivity>, View> {
        runBlocking(Dispatchers.IO) {
            app.graph.dao.deleteAllHistory()
            app.graph.store.putPeer(peer(laptop, "Laptop"))
            app.graph.store.putPeer(peer(phone, "Phone"))
            for (r in rows) app.graph.dao.insertHistory(r)
        }
        val vm = AppViewModel(app)
        scope.launch { recomposer.runRecomposeAndApplyChanges() }
        val c = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val view = ComposeView(c.get()).apply { setParentCompositionContext(recomposer) }
        c.get().setContentView(view)
        view.setContent { PushArmorTheme(dark = false) { HistoryScreen(vm) } }
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

    private fun sent(body: String, results: String) = HistoryEntity(direction = "SENT", peerId = null, type = "text", content = body, n = null,
        pairingId = null, at = System.currentTimeMillis(), read = true, results = results, count = 1)

    @Test fun recipientsLineTogglesOnlyItsList() {
        val (c, v) = show(listOf(sent("hello both", "{\"$laptop\":\"sent\",\"$phone\":\"unreachable\"}")), "hello both")
        fun has(t: String) = nodes(v).any { text(it) == t }
        assertTrue(has("Sent to 1 of 2 devices"))
        assertFalse(has("Recipients"))
        tap(v, nodes(v).first { text(it) == "hello both" })
        assertEquals("Expanded", state(v, "hello both"))
        // closed at first: the line and its chevron, no devices
        assertEquals("Collapsed", state(v, "Recipients"))
        assertFalse(has("Failed"))
        val line = generateSequence(nodes(v).first { text(it) == "Recipients" }) { it.parent }.first { it.config.getOrNull(SemanticsProperties.StateDescription) != null }
        assertEquals(androidx.compose.ui.semantics.Role.Button, line.config.getOrNull(SemanticsProperties.Role))
        // a tap on it opens only the list: one line per device, its name then Sent or Failed; the row stays open
        tap(v, nodes(v).first { text(it) == "Recipients" })
        assertEquals("Expanded", state(v, "Recipients"))
        assertEquals("Expanded", state(v, "hello both"))
        // "Sent" is also the filter chip at the top; the device's word is the lowest one
        assertTrue(has("Laptop") && has("Phone") && has("Failed"))
        assertEquals(2, nodes(v).count { text(it) == "Sent" })
        val laptopRow = nodes(v).first { text(it) == "Laptop" }.boundsInWindow
        val sentWord = nodes(v).filter { text(it) == "Sent" }.maxBy { it.boundsInWindow.top }.boundsInWindow
        assertTrue(sentWord.left > laptopRow.left && kotlin.math.abs(sentWord.center.y - laptopRow.center.y) < 2f)
        // a tap on it again closes only the list
        tap(v, nodes(v).first { text(it) == "Recipients" })
        assertEquals("Collapsed", state(v, "Recipients"))
        assertFalse(has("Failed"))
        tap(v, nodes(v).first { text(it) == "Recipients" })
        assertTrue(has("Failed"))
        // a tap elsewhere on the row closes the row and the list; the list starts closed next time
        tap(v, nodes(v).first { text(it) == "hello both" })
        assertEquals("Collapsed", state(v, "hello both"))
        assertFalse(has("Recipients"))
        tap(v, nodes(v).first { text(it) == "hello both" })
        assertEquals("Collapsed", state(v, "Recipients"))
        assertFalse(has("Failed"))
        close(c)
    }

    @Test fun sendToOneDeviceHasNoRecipientsLine() {
        val (c, v) = show(listOf(sent("hello one", "{\"$laptop\":\"sent\"}")), "hello one")
        tap(v, nodes(v).first { text(it) == "hello one" })
        assertEquals("Expanded", state(v, "hello one"))
        assertFalse(nodes(v).any { text(it) == "Recipients" })
        close(c)
    }

    @Test fun filterWithNoMatchSaysSo() {
        val received = HistoryEntity(direction = "RECEIVED", peerId = null, type = "text", content = "a note", n = null,
            pairingId = null, at = System.currentTimeMillis(), read = true, results = "", count = 1)
        val (c, v) = show(listOf(received), "a note")
        assertFalse(nodes(v).any { text(it) == "No matching messages" })
        tap(v, nodes(v).first { text(it) == "Sent" })
        assertTrue(nodes(v).any { text(it) == "No matching messages" })
        assertFalse(nodes(v).any { text(it) == "a note" })
        tap(v, nodes(v).first { text(it) == "Sent" })
        assertFalse(nodes(v).any { text(it) == "No matching messages" })
        assertTrue(nodes(v).any { text(it) == "a note" })
        close(c)
    }
}
