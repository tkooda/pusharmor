package com.pusharmor.app

import android.Manifest
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.material3.Text
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.ui.PermissionGate
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** State that must survive a rotation (activity recreate). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = android.app.Application::class)
class UiRotationTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Suppress("UNCHECKED_CAST")
    private fun windows(): List<View> {
        val c = Class.forName("android.view.WindowManagerGlobal")
        val inst = c.getMethod("getInstance").invoke(null)
        val f = c.getDeclaredField("mViews"); f.isAccessible = true
        return (f.get(inst) as List<View>).filter { it.isAttachedToWindow && it.visibility == View.VISIBLE }
    }

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes() = windows().flatMap { roots(it) }.flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }

    @Test fun notificationPermissionAskedOncePerVisit() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        UiHostActivity.content = { PermissionGate { Text("in") } }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup(); idle()
        assertNotNull(shadowOf(c.get()).lastRequestedPermission)
        // Rotated while the system dialog is up: the new activity does not ask a second time (I522).
        c.recreate(); idle()
        assertNull(shadowOf(c.get()).lastRequestedPermission)
        c.pause().stop().destroy()
    }
}
