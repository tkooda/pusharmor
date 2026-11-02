package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import com.pusharmor.app.UiHostActivity
import com.pusharmor.app.notify.PeerStatus
import com.pusharmor.app.ui.theme.PaIcons
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Rows that wrap or stack on a small screen or at a large font instead of breaking words. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = android.app.Application::class)
class RowFitTest {
    private lateinit var a: UiHostActivity

    private fun show(widthDp: Int, font: Float, content: @Composable () -> Unit) {
        RuntimeEnvironment.setQualifiers("w${widthDp}dp-h800dp-xhdpi")
        RuntimeEnvironment.setFontScale(font)
        UiHostActivity.content = content
        a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }
    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes() = roots(a.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun node(t: String) = nodes().first { it.config.getOrNull(SemanticsProperties.Text)?.any { x -> x.text == t } == true }
    private fun box(t: String): Rect = node(t).boundsInRoot
    private fun lines(t: String): Int {
        val res = mutableListOf<TextLayoutResult>()
        node(t).config[SemanticsActions.GetTextLayoutResult].action?.invoke(res)
        return res.first().lineCount
    }
    private fun icons(): Rect = nodes().first { it.config.getOrNull(SemanticsProperties.ContentDescription)?.any { d -> d.startsWith("Send screen") } == true }.boundsInRoot

    /** A device row as on the Devices screen: icon tile, name, platform and status lines, status icons, overflow. */
    private fun deviceRow(widthDp: Int, font: Float) = show(widthDp, font) {
        Box(Modifier.width((widthDp - 32).dp)) {
            ListItem(leadingContent = { Box(Modifier.width(40.dp)) }, headlineContent = { Text("Missing phone") },
                supportingContent = {
                    LinesBesideIcons({ Text("Command line"); Text("(missing)") }) {
                        PeerStatusIcons(listOf("Send screen", "Content in notifications", "Content on lock screen", "Watch", "Sharing shortcut")
                            .map { PaIcons.Send to PeerStatus(it, true) })
                    }
                },
                trailingContent = { Box(Modifier.width(48.dp)) })
        }
    }

    @Test fun deviceRowKeepsIconsBesideTheLinesAt411dp() {
        deviceRow(411, 1.0f)
        assertTrue("${icons()} ${box("Command line")}", icons().left >= box("Command line").right && icons().top < box("(missing)").bottom)
    }

    @Test fun deviceRowPutsIconsUnderTheLinesAt360dp() {
        deviceRow(360, 1.0f)
        assertEquals(1, lines("Command line")); assertEquals(1, lines("(missing)"))
        assertTrue("${icons()}", icons().top >= box("(missing)").bottom)
    }

    @Test fun deviceRowPutsIconsUnderTheLinesAtLargeFont() {
        deviceRow(411, 1.5f)
        assertEquals(1, lines("Command line"))
        assertTrue("${icons()}", icons().top >= box("(missing)").bottom)
    }

    private fun buttons(rowDp: Int) = show(411, 1.0f) {
        Box(Modifier.width(rowDp.dp)) {
            ButtonRow {
                OutlinedButton(onClick = {}) { Text("Cancel pairing request") }
                TextButton(onClick = {}) { Text("Send again") }
            }
        }
    }

    @Test fun buttonRowKeepsOneRowWhenTheButtonsFit() {
        buttons(340)
        assertEquals(box("Cancel pairing request").center.y, box("Send again").center.y, 1f)
        assertTrue(box("Cancel pairing request").right < box("Send again").left)
    }

    @Test fun buttonRowStacksWithThePrimaryButtonOnTop() {
        buttons(260)
        assertEquals(1, lines("Send again")); assertEquals(1, lines("Cancel pairing request"))
        assertTrue(box("Send again").bottom <= box("Cancel pairing request").top)
    }

    private fun footer(widthDp: Int, font: Float) = show(widthDp, font) {
        // The pairing card's footer is the screen width less 64 dp of margins and padding.
        Box(Modifier.width((widthDp - 64).dp)) { PairingFooter("Times out in 23 hours") {} }
    }

    @Test fun pairingTimeoutSitsBesideTheButtonWhenBothFit() {
        footer(600, 1.0f)
        assertTrue(box("Times out in 23 hours").left > box("Cancel pairing request").right)
    }

    @Test fun pairingTimeoutWrapsUnderTheButtonAtLargeFont() = timeoutUnderButton(360, 1.3f)

    @Test fun pairingTimeoutWrapsUnderTheButtonAt411dp() = timeoutUnderButton(411, 1.0f)

    private fun timeoutUnderButton(widthDp: Int, font: Float) {
        footer(widthDp, font)
        assertEquals(1, lines("Times out in 23 hours")); assertEquals(1, lines("Cancel pairing request"))
        assertTrue(box("Times out in 23 hours").top >= box("Cancel pairing request").bottom)
    }
}
