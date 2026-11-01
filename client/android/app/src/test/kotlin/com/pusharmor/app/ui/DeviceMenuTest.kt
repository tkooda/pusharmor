package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.UiHostActivity
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.SelfEntity
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The per-device menu on the Devices tab stays on screen. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class DeviceMenuTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    /** On a short window with large text the device menu stays inside the screen margins and scrolls to its last item. */
    @Config(qualifiers = "w412dp-h480dp-420dpi", fontScale = 2f)
    @Test fun deviceMenuFitsShortWindow() {
        val c = Robolectric.buildActivity(UiHostActivity::class.java)
        try { check(c) } finally {
            // Close the menu and the activity, so no popup keeps posting into the next test.
            windows().filter { (it.layoutParams as android.view.WindowManager.LayoutParams).type >= 1000 }.forEach { v ->
                v.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK))
                v.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_BACK))
            }
            popupIdle()
            runCatching { c.pause().stop().destroy() }; idle()
        }
    }

    private fun check(c: org.robolectric.android.controller.ActivityController<UiHostActivity>) {
        unstickFrames()
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val t = Thread {
            app.graph.dao.putSelf(SelfEntity(id = "s".repeat(40), accountPrefix = ByteArray(9), name = "Pixel 8", email = "someone@example.com"))
            app.graph.dao.putPeer(PeerEntity(
                id = "a".repeat(40), platform = "android", created = 1, listSignPub = null, listEncPub = null,
                signPub = "B".repeat(87), encPub = "C".repeat(87), pairingId = ByteArray(16), approved = true, deniedByMe = false,
                approveVerified = true, listApprovesMe = true, listDeniesMe = false, listAfterVerify = true, declined = false,
                reachable = true, loggedOut = false, logoutN = 0, hidden = false, name = "Galaxy S23", nameN = 1, removed = false, missing = false,
                lastN = 0, channelId = null, storedApprove = null, storedApproveName = null, lastApproveResult = null, lastSendAt = 0, note = null,
            ))
        }
        t.start(); t.join()
        val vm = AppViewModel(app)
        UiHostActivity.content = { PeersScreen(vm) }
        val a = c.setup().get()
        idle()
        var more: SemanticsNode? = null
        // Room loads the device on another thread.
        for (i in 0 until 100) {
            more = nodes(a.window.decorView).firstOrNull { n ->
                n.config.getOrNull(SemanticsProperties.ContentDescription)?.any { it == "More options for Galaxy S23" } == true
            }
            if (more != null) break
            Thread.sleep(50); idle()
        }
        while (more != null && more.config.getOrNull(SemanticsActions.OnClick) == null) more = more.parent
        more!!.config[SemanticsActions.OnClick].action!!.invoke()
        var popup: View? = null
        for (i in 0 until 20) {
            popupIdle()
            popup = windows().lastOrNull { (it.layoutParams as android.view.WindowManager.LayoutParams).type >= 1000 && it.height > 0 } // a sub window
            if (popup != null) break
        }
        assertNotNull("menu did not open", popup)
        popup!!
        val screen = a.window.decorView.height
        // Short enough for the stock menu to place it between its 48 dp margins (the test window draws no system bars).
        val margin = 48 * a.resources.displayMetrics.density
        assertTrue("popup h=${popup.height} screen=$screen", popup.height > 0 && popup.height <= screen - 2 * margin + 1)
        val menu = nodes(popup)
        val scroll = menu.first { it.config.getOrNull(SemanticsActions.ScrollBy) != null }
        scroll.config[SemanticsActions.ScrollBy].action!!.invoke(0f, 100000f); popupIdle()
        val remove = nodes(popup).firstOrNull { text(it) == "Remove device from account" }
        assertNotNull(remove)
        val b = remove!!.boundsInRoot
        assertTrue("remove $b in popup ${popup.height}", b.top >= 0 && b.bottom <= popup.height + 1)
    }

    /**
     * Compose keeps one UI dispatcher per thread for the whole test run. When an earlier test ends with a frame or a task
     * queued, Robolectric clears the queue but the dispatcher still thinks one is pending, so no frame comes and a tap
     * never recomposes. Clear those two flags so the next change schedules a frame again.
     */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }

    /** Bounded: an open popup re-posts its position check at zero delay, so a plain idle never ends. */
    private fun popupIdle() {
        val ml = shadowOf(Looper.getMainLooper())
        repeat(50) {
            Thread.sleep(10)
            org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofMillis(20))
            var k = 0
            while (!ml.isIdle && k < 400) { ml.runOneTask(); k++ }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun windows(): List<View> {
        val c = Class.forName("android.view.WindowManagerGlobal")
        val f = c.getDeclaredField("mViews").apply { isAccessible = true }
        return (f.get(c.getMethod("getInstance").invoke(null)) as List<View>).filter { it.isAttachedToWindow && it.visibility == View.VISIBLE }
    }
}
