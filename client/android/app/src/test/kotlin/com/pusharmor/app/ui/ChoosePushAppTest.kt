package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.UiHostActivity
import com.pusharmor.app.data.Settings
import com.pusharmor.app.push.UnifiedPushSupport
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/** Several UnifiedPush apps and none chosen: a banner on the main screen whose Choose opens Settings > Push method. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class ChoosePushAppTest {
    private val installed = UnifiedPushSupport.installed
    private val saved = UnifiedPushSupport.saved
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val two = listOf("io.heckel.ntfy", "org.unifiedpush.distributor.sunup")

    @After fun restore() {
        UnifiedPushSupport.installed = installed
        UnifiedPushSupport.saved = saved
        app.graph.settings.set(Settings.K.PUSH_TYPE, null)
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
    /** The settings load on the DataStore thread, which idle() does not wait for; the banner needs them. */
    private fun loaded(vm: AppViewModel): AppViewModel {
        val end = System.currentTimeMillis() + 10_000
        while (vm.prefs.value == null && System.currentTimeMillis() < end) { Thread.sleep(5); idle() }
        assertNotNull(vm.prefs.value)
        return vm
    }
    /** A frame left pending by an earlier test would stop the Push method choice from opening; clear it. */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }
    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }
    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    @Test fun rule() {
        UnifiedPushSupport.saved = { null }
        UnifiedPushSupport.installed = { two }
        assertTrue(UnifiedPushSupport.mustChoose(app, "unifiedpush", playServices = true))
        assertTrue(UnifiedPushSupport.mustChoose(app, null, playServices = false))
        assertFalse(UnifiedPushSupport.mustChoose(app, null, playServices = true))
        assertFalse(UnifiedPushSupport.mustChoose(app, "fcm", playServices = true))
        UnifiedPushSupport.installed = { two.take(1) }
        assertFalse(UnifiedPushSupport.mustChoose(app, "unifiedpush", playServices = true))
        UnifiedPushSupport.installed = { emptyList() }
        assertFalse(UnifiedPushSupport.mustChoose(app, "unifiedpush", playServices = true))
        UnifiedPushSupport.installed = { two }
        UnifiedPushSupport.saved = { two[0] }
        assertFalse(UnifiedPushSupport.mustChoose(app, "unifiedpush", playServices = true))
    }

    @Test fun bannerChooseOpensPushMethod() {
        UnifiedPushSupport.saved = { null }
        UnifiedPushSupport.installed = { two }
        app.graph.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        val vm = loaded(AppViewModel(app))
        var chosen = 0
        UiHostActivity.content = { PeersScreen(vm, onChoosePush = { chosen++ }) }
        unstickFrames()
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        idle()
        val all = nodes(a.window.decorView)
        assertTrue(all.count { text(it) == UiText.CHOOSE_PUSH_APP } == 1)
        var n: SemanticsNode? = all.first { text(it) == "Choose" }
        while (n != null && n.config.getOrNull(SemanticsActions.OnClick) == null) n = n.parent
        n!!.config[SemanticsActions.OnClick].action!!.invoke()
        assertEquals(1, chosen)

        // Settings opens the Push method choice once.
        vm.openPushMethod.value = true
        UiHostActivity.content = { SettingsScreen(vm, onDeleteAccount = {}, onSignedOut = {}) }
        unstickFrames()
        val s = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        idle()
        assertFalse(vm.openPushMethod.value)
        s.recreate(); idle()
        val dialog = nodes(ShadowDialog.getLatestDialog().window!!.decorView).map { text(it) }
        assertTrue(dialog.toString(), "Push method" in dialog && UiText.UNIFIEDPUSH_NOTE in dialog)
    }

    @Test fun noBannerOnceChosen() {
        UnifiedPushSupport.saved = { "io.heckel.ntfy" }
        UnifiedPushSupport.installed = { two }
        app.graph.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        val vm = loaded(AppViewModel(app))
        UiHostActivity.content = { PeersScreen(vm) }
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        idle()
        assertTrue(nodes(a.window.decorView).none { text(it) == UiText.CHOOSE_PUSH_APP })
    }
}
