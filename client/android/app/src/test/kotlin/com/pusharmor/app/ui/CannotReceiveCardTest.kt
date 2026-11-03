package com.pusharmor.app.ui

import android.Manifest
import android.app.NotificationManager
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
import com.pusharmor.store.SelfEntity
import com.pusharmor.app.session.Session
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The cannot-receive card sits above every signed-in tab and the logged-out screen, and one X hides it on all of them. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class CannotReceiveCardTest {
    private val title = "This device cannot receive messages."
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }
    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(a: android.app.Activity) = roots(a.window.decorView).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""
    private fun cards(a: android.app.Activity) = nodes(a).count { text(it) == title }
    /** Line 2 says why and the button says what to do (notifications are off in these tests). */
    private fun reasonAndAction(a: android.app.Activity) =
        nodes(a).count { text(it) == "Allow notifications for PushArmor in Settings." } == 1 && nodes(a).count { text(it) == "Fix" } == 1

    /** A frame left pending by an earlier test would stop every tap here from recomposing; clear it. */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }

    private fun app(notificationsOn: Boolean): PaApp {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        shadowOf(app.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(notificationsOn)
        app.graph.settings.set(Settings.K.PUSH_TYPE, "fcm")
        return app
    }

    private fun show(app: PaApp, start: Session.Start): Pair<android.app.Activity, AppViewModel> {
        // A signed-in screen without its own row would go back to log in.
        if (start == Session.Start.READY) {
            val t = Thread { app.graph.dao.putSelf(SelfEntity(id = "s".repeat(40), accountPrefix = ByteArray(9), name = "Pixel 8")) }
            t.start(); t.join()
        }
        val vm = AppViewModel(app)
        vm.start.value = start
        UiHostActivity.content = { App(vm) }
        unstickFrames()
        val a = Robolectric.buildActivity(UiHostActivity::class.java).setup().get()
        idle()
        return a to vm
    }

    private fun tap(a: android.app.Activity, label: String) {
        var n: SemanticsNode? = nodes(a).first { text(it) == label || it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains(label) == true }
        while (n != null && n.config.getOrNull(SemanticsActions.OnClick) == null) n = n.parent
        unstickFrames()
        n!!.config[SemanticsActions.OnClick].action!!.invoke()
        idle()
    }

    @Test fun signedInShowsOneCardOnDevicesAndOnOtherTabs() {
        val (a, _) = show(app(false), Session.Start.READY)
        assertTrue(cards(a) == 1)
        assertTrue("reason and action", reasonAndAction(a))
        tap(a, "Send")
        assertTrue("send tab", cards(a) == 1)
        tap(a, "History")
        assertTrue("history tab", cards(a) == 1)
        tap(a, "Settings")
        assertTrue("settings tab", cards(a) == 1)
    }

    @Test fun closingTheCardHidesItOnEveryTab() {
        val (a, vm) = show(app(false), Session.Start.READY)
        tap(a, "Send")
        tap(a, "Close")
        assertTrue(cards(a) == 0)
        tap(a, "History")
        assertTrue(cards(a) == 0)
        tap(a, "Devices")
        assertTrue(cards(a) == 0)
        assertTrue(vm.cannotReceiveClosed.value)
    }

    @Test fun loggedOutScreenShowsTheCardAndCloseHidesIt() {
        val (a, _) = show(app(false), Session.Start.SIGNED_OUT)
        assertTrue(cards(a) == 1)
        assertTrue("reason and action", reasonAndAction(a))
        tap(a, "Close")
        assertTrue(cards(a) == 0)
    }

    @Test fun noCardWhenNotificationsAreOn() {
        val (a, _) = show(app(true), Session.Start.READY)
        assertTrue(cards(a) == 0)
        val (b, _) = show(app(true), Session.Start.SIGNED_OUT)
        assertTrue(cards(b) == 0)
    }

    /** Live check: UnifiedPush in use and no UnifiedPush app -> card with the one Get a UnifiedPush app button; one installed -> no card on the next open. */
    @Test fun noPushAppCardFollowsInstalledApps() {
        val saved = UnifiedPushSupport.installed
        try {
            val app = app(true)
            app.graph.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
            app.graph.settings.set(Settings.K.BANNER, null) // the stored flag is not what decides
            UnifiedPushSupport.installed = { emptyList() }
            val (a, _) = show(app, Session.Start.READY)
            assertTrue(cards(a) == 1)
            assertTrue(nodes(a).count { text(it) == UiText.noPushApp(app.graph.push.hasPlayServices) } == 1)
            assertTrue(nodes(a).count { text(it) == UiText.GET_PUSH_APP } == 1 && nodes(a).none { text(it) == "Get ntfy" || text(it) == "Get Sunup" })
            UnifiedPushSupport.installed = { listOf("io.heckel.ntfy") }
            app.graph.settings.set(Settings.K.BANNER, "no_distributor") // a stale flag does not bring the card back
            val (b, _) = show(app, Session.Start.READY)
            assertTrue(cards(b) == 0)
        } finally { UnifiedPushSupport.installed = saved }
    }

    @Test fun firstSignInScreenShowsNoCard() {
        val (a, _) = show(app(false), Session.Start.SIGN_IN)
        assertTrue(cards(a) == 0)
    }

    @Test fun cardComesBackOnNewOpenAfterClose() {
        val app = app(false)
        val (a, _) = show(app, Session.Start.READY)
        tap(a, "Close")
        val (b, _) = show(app, Session.Start.READY)
        assertTrue(cards(b) == 1)
    }

    /** A relay-side fault on Google push: the card with the relay server line and Check again; UnifiedPush never shows it. */
    @Test fun relayFaultCardOnGooglePushOnly() {
        val app = app(true)
        app.graph.settings.set(Settings.K.RELAY_FAULT, true)
        try {
            val (a, _) = show(app, Session.Start.READY)
            assertTrue(cards(a) == 1)
            assertTrue(nodes(a).count { text(it) == UiText.RELAY_FAULT } == 1 && nodes(a).count { text(it) == UiText.CHECK_AGAIN } == 1)
            val saved = UnifiedPushSupport.installed
            try {
                UnifiedPushSupport.installed = { listOf("io.heckel.ntfy") }
                app.graph.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
                val (b, _) = show(app, Session.Start.READY)
                assertTrue(nodes(b).none { text(it) == UiText.RELAY_FAULT })
            } finally { UnifiedPushSupport.installed = saved }
        } finally { app.graph.settings.set(Settings.K.RELAY_FAULT, null) }
    }
}
