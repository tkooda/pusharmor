package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
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

/** Dialogs are stock Material3 AlertDialogs with TextButtons (I603). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
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
}
