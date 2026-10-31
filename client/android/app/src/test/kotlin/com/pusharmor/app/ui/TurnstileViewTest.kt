package com.pusharmor.app.ui

import android.content.Context
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.webkit.WebViewFeature
import com.pusharmor.app.UiHostActivity
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowWebView

@Implements(WebViewFeature::class)
class ThrowingWebViewFeature {
    companion object { @JvmStatic @Implementation fun isFeatureSupported(feature: String): Boolean = throw IllegalStateException("WebView updating") }
}

@Implements(WebViewFeature::class)
class SupportedWebViewFeature {
    companion object { @JvmStatic @Implementation fun isFeatureSupported(feature: String): Boolean = true }
}

@Implements(WebView::class)
class MissingWebView : ShadowWebView() {
    @Implementation protected fun __constructor__(context: Context) { throw RuntimeException("No WebView installed") }
}

/** A missing or updating WebView shows the update fallback on the email step instead of crashing (I552). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class, instrumentedPackages = ["androidx.webkit"])
class TurnstileViewTest {
    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }

    private fun showsFallback(): Boolean {
        UiHostActivity.content = { TurnstileView(onNoApp = {}) {} }
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        shadowOf(Looper.getMainLooper()).idle()
        return roots(a.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
            .any { it.config.getOrNull(SemanticsProperties.Text)?.any { t -> t.text == "Open Play Store" } == true }
    }

    @Config(shadows = [ThrowingWebViewFeature::class])
    @Test fun featureCheckFailureShowsFallback() { assertTrue(showsFallback()) }

    @Config(shadows = [SupportedWebViewFeature::class, MissingWebView::class])
    @Test fun webViewCreationFailureShowsFallback() { assertTrue(showsFallback()) }
}
