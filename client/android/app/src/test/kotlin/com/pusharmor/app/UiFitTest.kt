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
import com.pusharmor.app.ui.UiText
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.app.ui.theme.PaTopBar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import com.pusharmor.app.ui.theme.PushArmorTheme
import org.junit.Assert.assertEquals
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
}
