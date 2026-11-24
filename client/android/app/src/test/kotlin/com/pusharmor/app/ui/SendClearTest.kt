package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.AnnotatedString
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.UiHostActivity
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A sent message clears the Send field, also when Send shows again from saved state; a failed send keeps the text. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SendClearTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun field(a: android.app.Activity) = roots(a.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
        .first { it.config.getOrNull(SemanticsActions.SetText) != null }
    private fun fieldText(a: android.app.Activity) = field(a).config.getOrNull(SemanticsProperties.EditableText)?.text ?: ""

    /** A frame left queued by an earlier test stops later frames (see TabSwitchTest): cleared before and after. */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }

    private fun check(result: AppViewModel.SendResult, expected: String) {
        unstickFrames()
        val vm = AppViewModel(ApplicationProvider.getApplicationContext<PaApp>())
        UiHostActivity.content = { SendScreen(vm, title = "Send") }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        idle()
        field(c.get()).config[SemanticsActions.SetText].action!!.invoke(AnnotatedString("hello"))
        idle()
        assertEquals("hello", fieldText(c.get()))
        vm.sendDone.value = result
        idle()
        // Send shows again from saved state, as after a tab switch.
        c.recreate(); idle()
        assertEquals(expected, fieldText(c.get()))
        c.pause().stop().destroy()
        idle()
        unstickFrames()
    }

    @Test fun sentMessageClearsTheField() = check(AppViewModel.SendResult("Sent", 7L), "")

    @Test fun failedSendKeepsTheText() = check(AppViewModel.SendResult("Unable to send.\nTry again."), "hello")
}
