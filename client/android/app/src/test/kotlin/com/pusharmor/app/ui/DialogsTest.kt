package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.pusharmor.app.UiHostActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

/** Dialogs are stock Material3 AlertDialogs with TextButtons. */
@RunWith(RobolectricTestRunner::class)
// TestApp: it keeps Room's invalidation service unbound, which a Room open left running by an earlier test can reach.
@Config(sdk = [34], application = com.pusharmor.app.TestApp::class)
class DialogsTest {
    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** Semantics nodes of the dialog on screen. */
    private fun dialogNodes(): List<SemanticsNode> =
        roots(ShadowDialog.getLatestDialog().window!!.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }

    private fun texts(): List<String> = dialogNodes().flatMap { n -> n.config.getOrNull(SemanticsProperties.Text)?.map { it.text } ?: emptyList() }

    /** Clicks the nearest clickable node that holds [text]. */
    private fun click(text: String) {
        var n: SemanticsNode? = dialogNodes().first { it.config.getOrNull(SemanticsProperties.Text)?.any { t -> t.text == text } == true }
        while (n != null && n.config.getOrNull(SemanticsActions.OnClick) == null) n = n.parent
        n!!.config[SemanticsActions.OnClick].action!!.invoke()
        idle()
    }

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        UiHostActivity.content = content
        Robolectric.buildActivity(UiHostActivity::class.java).setup()
        idle()
    }

    @Test fun deleteAccountDialogHasTitleTextContinueAndCancel() {
        var confirmed = 0
        var dismissed = 0
        show { DeleteAccountDialog(onConfirm = { confirmed++ }) { dismissed++ } }
        val t = texts()
        assertTrue(t.toString(), t.containsAll(listOf("Delete account", UiText.DELETE_CONFIRM, "Continue", "Cancel")))
        click("Cancel")
        assertEquals(0 to 1, confirmed to dismissed)
        click("Continue")
        assertEquals(1 to 1, confirmed to dismissed)
    }

    /** Semantics nodes of the activity window (not a dialog). */
    private fun screenNodes(a: android.app.Activity): List<SemanticsNode> = roots(a.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }

    private fun clickIn(nodes: List<SemanticsNode>, text: String) {
        var n: SemanticsNode? = nodes.first { it.config.getOrNull(SemanticsProperties.Text)?.any { t -> t.text == text } == true }
        while (n != null && n.config.getOrNull(SemanticsActions.OnClick) == null) n = n.parent
        n!!.config[SemanticsActions.OnClick].action!!.invoke()
        idle()
    }

    @Test fun keysBrokenScreenDeletesOnlyAfterTheDialogDelete() {
        var retried = 0
        var deleted = 0
        UiHostActivity.content = { KeysBrokenScreen(onRetry = { retried++ }, onDelete = { deleted++ }) }
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        idle()
        val screen = screenNodes(a).flatMap { n -> n.config.getOrNull(SemanticsProperties.Text)?.map { it.text } ?: emptyList() }
        assertTrue(screen.toString(), screen.containsAll(listOf(UiText.KEYS_BROKEN_TITLE, UiText.KEYS_BROKEN_BODY, "Retry", "Delete broken keys")))
        clickIn(screenNodes(a), "Retry")
        assertEquals(1 to 0, retried to deleted)
        clickIn(screenNodes(a), "Delete broken keys")
        assertTrue(texts().containsAll(listOf(UiText.KEYS_BROKEN_DIALOG_TITLE, UiText.KEYS_BROKEN_DIALOG_BODY, "Cancel", "Delete")))
        click("Cancel")
        assertEquals(1 to 0, retried to deleted)
        clickIn(screenNodes(a), "Delete broken keys")
        click("Delete")
        assertEquals(1 to 1, retried to deleted)
    }

    @Test fun dataBrokenScreenResetsOnlyAfterTheDialogReset() {
        var retried = 0
        var reset = 0
        UiHostActivity.content = { DataBrokenScreen(onRetry = { retried++ }, onReset = { reset++ }) }
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        idle()
        val screen = screenNodes(a).flatMap { n -> n.config.getOrNull(SemanticsProperties.Text)?.map { it.text } ?: emptyList() }
        assertTrue(screen.toString(), screen.containsAll(listOf("This device's data has become unusable.", UiText.DATA_BROKEN_BODY, "Retry", "Reset this device")))
        clickIn(screenNodes(a), "Retry")
        assertEquals(1 to 0, retried to reset)
        clickIn(screenNodes(a), "Reset this device")
        assertTrue(texts().containsAll(listOf(UiText.DATA_BROKEN_DIALOG_TITLE, UiText.DATA_BROKEN_DIALOG_BODY, "Cancel", "Reset")))
        click("Cancel")
        assertEquals(1 to 0, retried to reset)
        clickIn(screenNodes(a), "Reset this device")
        click("Reset")
        assertEquals(1 to 1, retried to reset)
    }

    @Test fun choiceDialogAppliesOnOkOnly() {
        var open by mutableStateOf(true)
        val chosen = mutableListOf<String>()
        show { if (open) ChoiceDialog("Theme", listOf("A", "B", "C"), "A", { it }, onDismiss = { open = false }) { chosen.add(it) } }
        assertTrue(texts().containsAll(listOf("Theme", "A", "B", "C", "OK", "Cancel")))
        // A row tap only moves the radio; Cancel keeps the old value.
        click("B")
        assertEquals(listOf<String>(), chosen)
        click("Cancel")
        assertEquals(listOf<String>(), chosen)
        open = true
        idle()
        click("C")
        click("OK")
        assertEquals(listOf("C"), chosen)
    }

    /** The share sheet Send is a floating, dimmed dialog nearly as wide as the screen and as tall as its content. */
    @Test fun shareSheetIsAFloatingDialog() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val i = android.content.Intent(android.content.Intent.ACTION_SEND).setClassName(ctx, ShareActivity::class.java.name)
            .setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, "https://example.com/")
        // Only created, never resumed: a resumed share sheet shows an endless progress spinner while its peer read runs on a
        // real thread, so idling the looper then spins frames for as long as that read takes (minutes, or out of memory).
        val a = Robolectric.buildActivity(ShareActivity::class.java, i).create().get()
        val w = a.window
        assertTrue(w.isFloating)
        assertTrue(w.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND != 0)
        assertEquals((a.resources.displayMetrics.widthPixels * ShareActivity.DIALOG_WIDTH).toInt(), w.attributes.width)
        assertEquals(android.view.WindowManager.LayoutParams.WRAP_CONTENT, w.attributes.height)
    }
}
