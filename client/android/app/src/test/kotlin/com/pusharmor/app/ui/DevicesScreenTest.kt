package com.pusharmor.app.ui

import android.app.NotificationManager
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/** The Devices tab: spacing under the top bar and the Pair a new device button. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class DevicesScreenTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    private fun show(): android.app.Activity {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val vm = AppViewModel(app)
        UiHostActivity.content = { PeersScreen(vm) }
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        idle()
        return a
    }

    /** The first banner card sits 8 dp below the top bar, not against it (I614). */
    @Test fun bannerHasGapUnderTopBar() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        shadowOf(app.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
        val a = show()
        val all = nodes(a.window.decorView)
        val list = all.first { it.config.getOrNull(SemanticsActions.ScrollBy) != null }
        val banner = all.first { text(it).startsWith("Notifications are off") }
        val d = a.resources.displayMetrics.density
        // 8 dp list padding plus the card's own 16 dp top padding.
        assertTrue("${banner.boundsInRoot.top - list.boundsInRoot.top}", banner.boundsInRoot.top - list.boundsInRoot.top >= 24 * d - 1)
    }
}
