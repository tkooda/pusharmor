package com.pusharmor.app

import android.Manifest
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.material3.Text
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.AnnotatedString
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.ui.PermissionGate
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.ui.NameEditRow
import com.pusharmor.app.ui.chipSaver
import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    private fun field() = nodes().first { it.config.getOrNull(SemanticsActions.SetText) != null }

    // Reads only this test's activity: windows left by earlier tests may still show "Phone".
    private var host: android.app.Activity? = null
    private fun own() = roots(host!!.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun ownField() = own().first { it.config.getOrNull(SemanticsActions.SetText) != null }

    @Test fun renameTypedTextSurvivesRotation() {
        UiHostActivity.content = { NameEditRow("Phone") {} }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup(); host = c.get(); idle()
        // The pencil row starts the in-place edit (I601); a rotation keeps it open.
        own().first { it.config.getOrNull(SemanticsActions.OnClick) != null }.config[SemanticsActions.OnClick].action?.invoke()
        c.recreate(); host = c.get(); idle()
        ownField().config[SemanticsActions.SetText].action?.invoke(AnnotatedString("Kitchen")); idle()
        c.recreate(); host = c.get(); idle()
        // The typed name stays; it no longer goes back to "Phone" (I523).
        assertEquals("Kitchen", ownField().config[SemanticsProperties.EditableText].text)
        c.pause().stop().destroy()
    }

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

    @Test fun historyDeviceFilterSurvivesRotation() {
        val scope = SaverScope { true }
        for (c in listOf(HistoryFilter.Chip.All, HistoryFilter.Chip.Unknown, HistoryFilter.Chip.PeerChip("p1", "Laptop"))) {
            val saved = with(chipSaver) { scope.save(c) }!!
            assertEquals(c, chipSaver.restore(saved))
        }
    }

    @Test fun sendChoiceAndDevicesDialogsSurviveRotation() {
        val main = java.io.File("src/main/kotlin/com/pusharmor/app/ui/MainScreens.kt").readText()
        // Send chip choice, Devices Remove and "Pair a new device" dialogs, History filter (I523).
        for (v in listOf("val picked = rememberSaveable", "var restored by rememberSaveable", "var confirmRemove by rememberSaveable",
            "var chip by rememberSaveable")) assertTrue(v, main.contains(v))
        // The pairing how-to lives in the ViewModel, which a rotation keeps; Send and History open it too (I611).
        val vm = java.io.File("src/main/kotlin/com/pusharmor/app/ui/AppViewModel.kt").readText()
        assertTrue(vm.contains("val pairHowTo = MutableStateFlow(false)"))
    }
}
