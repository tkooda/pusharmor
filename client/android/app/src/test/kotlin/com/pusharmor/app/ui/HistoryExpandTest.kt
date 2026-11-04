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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/** History rows open and close on the first real touch, wherever on the tile it lands: one row open at a time. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class HistoryExpandTest {
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

    @Test fun firstTapOpensAndClosesRows() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val now = System.currentTimeMillis()
        val bodies = listOf("first note", "second note")
        runBlocking(Dispatchers.IO) {
            for ((i, body) in bodies.withIndex())
                app.graph.dao.insertHistory(HistoryEntity(direction = "RECEIVED", peerId = null, type = "text", content = body, n = null,
                    pairingId = null, at = now - i * 1000L, read = true, results = "", count = 1))
        }
        val vm = AppViewModel(app)
        scope.launch { recomposer.runRecomposeAndApplyChanges() }
        val c = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val view = ComposeView(c.get()).apply { setParentCompositionContext(recomposer) }
        c.get().setContentView(view)
        view.setContent { PushArmorTheme(dark = false) { HistoryScreen(vm) } }
        val v = c.get().window.decorView
        val end = System.currentTimeMillis() + 10_000
        while (nodes(v).none { text(it) == bodies[1] } && System.currentTimeMillis() < end) { Thread.sleep(20); frames(v) }
        assertTrue(nodes(v).any { text(it) == bodies[1] })
        fun rows() = bodies.map { state(v, it) }
        fun body(i: Int) = nodes(v).first { text(it) == bodies[i] }
        // The sender line of row i (rows are newest first, so in the order inserted).
        fun sender(i: Int) = nodes(v).filter { text(it) == "Unknown sender" }.sortedBy { it.boundsInWindow.top }[i]
        for (at in listOf(::body, ::sender)) {
            tap(v, at(0))
            assertEquals(listOf("Expanded", "Collapsed"), rows())
            // Another row, while one is open: it opens and the open one closes, on the first tap.
            tap(v, at(1))
            assertEquals(listOf("Collapsed", "Expanded"), rows())
            // The open row again: it closes.
            tap(v, at(1))
            assertEquals(listOf("Collapsed", "Collapsed"), rows())
        }
        c.pause().stop().destroy()
        recomposer.cancel()
        scope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }
}
