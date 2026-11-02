package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.material3.Text
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.pusharmor.app.UiHostActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A tab switch shows the new tab at once: no fade in which both tabs are on the screen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class TabSwitchTest {
    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }
    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun texts(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString { t -> t.text } }

    /**
     * Compose keeps one UI dispatcher per thread for the whole test run; a frame queued when a test ends is cleared by
     * Robolectric while the dispatcher still counts it as pending, so no later frame comes. Cleared before and after.
     */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }

    @Test fun tabSwitchHasNoAnimation() {
        unstickFrames()
        var nav: NavHostController? = null
        UiHostActivity.content = {
            val n = rememberNavController().also { nav = it }
            TabHost(n) {
                composable("peers") { Text("Devices tab") }
                composable("send") { Text("Send tab") }
            }
        }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        val a = c.get()
        shadowOf(Looper.getMainLooper()).idle()
        // The looper runs frames until the screen settles, moving the clock on: the time taken is the animation.
        val t0 = android.os.SystemClock.uptimeMillis()
        nav!!.navigate("send")
        shadowOf(Looper.getMainLooper()).idle()
        val took = android.os.SystemClock.uptimeMillis() - t0
        assertEquals(listOf("Send tab"), texts(a.window.decorView))
        assertTrue("tab switch took $took ms", took <= 50)
        c.pause().stop().destroy()
        shadowOf(Looper.getMainLooper()).idle()
        unstickFrames()
    }
}
