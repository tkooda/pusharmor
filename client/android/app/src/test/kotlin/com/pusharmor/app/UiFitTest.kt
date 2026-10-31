package com.pusharmor.app

import android.os.Bundle
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.pusharmor.app.ui.ChipRow
import com.pusharmor.app.ui.DismissSnackbarOnChange
import com.pusharmor.app.ui.FirstDeviceSteps
import com.pusharmor.app.ui.NavLabel
import com.pusharmor.app.ui.PaChip
import com.pusharmor.app.ui.UiText
import com.pusharmor.app.ui.UpdateScreen
import com.pusharmor.app.ui.sendScrolls
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.app.ui.theme.PaTopBar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import com.pusharmor.app.ui.theme.PushArmorTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Hosts one composable; set [content] before building it. */
class UiHostActivity : ComponentActivity() {
    companion object { var content: @Composable () -> Unit = {} }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { PushArmorTheme(dark = false) { content() } }
    }
}

/** Renders composables at small screens and large fonts and checks that the text fits (QA round 2). */
@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalLayoutApi::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = android.app.Application::class)
class UiFitTest {
    private fun show(qualifiers: String, font: Float, content: @Composable () -> Unit): ActivityController<UiHostActivity> {
        RuntimeEnvironment.setQualifiers(qualifiers)
        RuntimeEnvironment.setFontScale(font)
        UiHostActivity.content = content
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        shadowOf(Looper.getMainLooper()).idle()
        return c
    }

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }

    private fun nodes(a: ComponentActivity): List<SemanticsNode> =
        roots(a.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }

    private fun layoutOf(a: ComponentActivity, text: String): TextLayoutResult {
        val n = nodes(a).first { it.config.getOrNull(SemanticsProperties.Text)?.any { t -> t.text == text } == true }
        val res = mutableListOf<TextLayoutResult>()
        n.config[SemanticsActions.GetTextLayoutResult].action?.invoke(res)
        return res.first()
    }

    @Test fun firstDeviceStepsShowNumberedCircles() {
        val c = show("w360dp-h640dp-xhdpi", 2.0f) { FirstDeviceSteps() }
        val texts = nodes(c.get()).flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty().map { t -> t.text } }
        // One numbered circle beside each iOS step, in order (I607).
        for ((i, step) in UiText.FIRST_DEVICE_STEPS.withIndex()) {
            assertTrue(step, step in texts)
            assertEquals("${i + 1}", texts[texts.indexOf(step) - 1])
        }
    }

    @Test fun firstDeviceTitleIsOneLineAtLargeFont() {
        val c = show("w360dp-h640dp-xhdpi", 2.0f) {
            // The gate bar: Refresh and Settings actions (PeersScreen, firstDevice).
            PaTopBar(UiText.FIRST_DEVICE_TITLE, actions = {
                IconButton(onClick = {}) { Icon(PaIcons.Refresh, "Refresh") }
                IconButton(onClick = {}) { Icon(PaIcons.Settings, "Settings") }
            })
        }
        val l = layoutOf(c.get(), UiText.FIRST_DEVICE_TITLE)
        // One line; a title too long for the bar ends in an ellipsis and is never cut through a line (I519).
        assertEquals(1, l.lineCount)
        assertTrue(l.size.height <= l.layoutInput.constraints.maxHeight)
        assertTrue(l.isLineEllipsized(0))
    }

    @Test fun historyChipEndsInAnEllipsisAtLargeFont() {
        val name = "Kitchen tablet on the fridge 32"
        val c = show("w360dp-h640dp-xhdpi", 2.0f) {
            FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) { PaChip(true, name) {} }
        }
        val l = layoutOf(c.get(), name)
        // Too long for the row: the chip ends in an ellipsis, not a glyph cut in half (I524).
        assertTrue(l.isLineEllipsized(0))
    }

    @Test fun bottomBarLabelsReadInFullAtLargeFont() {
        val labels = listOf("Send", "History", "Devices", "Settings")
        val c = show("w360dp-h640dp-xhdpi", 2.0f) {
            NavigationBar {
                for (t in labels) NavigationBarItem(selected = t == "Send", onClick = {}, icon = { Icon(PaIcons.Send, null) }, label = { NavLabel(t) })
            }
        }
        // Each label reads in full: no "Devi..." at font 2.0 on a 360 dp screen (I525).
        for (t in labels) { val l = layoutOf(c.get(), t); assertEquals(t, 1, l.lineCount); assertFalse(t, l.isLineEllipsized(0)) }
    }

    @Test fun updateScreenScrollsInSmallLandscape() {
        val c = show("w640dp-h360dp-land-xhdpi", 2.0f) { UpdateScreen() }
        // At 640x360 and font 2.0 the Update button is reached by scrolling (I529).
        assertTrue(nodes(c.get()).any { it.config.getOrNull(SemanticsActions.ScrollBy) != null })
    }

    @Test fun sendScrollsWhenTheFieldCannotKeepItsLines() {
        // Landscape at font 2.0: 200 px above Send, chips 160 px, a 4-line field 300 px: the page scrolls (I520).
        assertTrue(sendScrolls(areaPx = 200, chipsPx = 160, extrasPx = 0, fieldMinPx = 300))
        // Portrait: room for the chips, the caption rows, and the field; the page does not scroll.
        assertFalse(sendScrolls(areaPx = 1400, chipsPx = 300, extrasPx = 100, fieldMinPx = 300))
        // Not measured yet: no scroll.
        assertFalse(sendScrolls(areaPx = 0, chipsPx = 0, extrasPx = 0, fieldMinPx = 300))
    }

    @Test fun historyFilterChipsStayOnOneRow() {
        val names = listOf("All", "Laptop", "Kitchen tablet on the fridge 32", "Sent", "Received")
        val c = show("w411dp-h891dp-xxhdpi", 1.0f) {
            ChipRow { for (t in names) PaChip(t == "All", t) {} }
        }
        val tops = names.map { t -> nodes(c.get()).first { n -> n.config.getOrNull(SemanticsProperties.Text)?.any { it.text == t } == true }.positionInRoot.y }
        // One row: Received does not drop to a line of its own (I571).
        assertEquals(tops.toString(), 1, tops.toSet().size)
    }

    @Test fun snackbarGoesWhenTheContentChanges() {
        val state = SnackbarHostState()
        var key by mutableStateOf("a")
        UiHostActivity.content = { DismissSnackbarOnChange(state, key); LaunchedEffect(Unit) { state.showSnackbar("No connection. Try again.") } }
        Robolectric.buildActivity(UiHostActivity::class.java).setup()
        shadowOf(Looper.getMainLooper()).idle()
        assertNotNull(state.currentSnackbarData)
        key = "b"
        shadowOf(Looper.getMainLooper()).idle()
        // The note about the last send does not stay over a new message (I572).
        assertNull(state.currentSnackbarData)
    }
}
