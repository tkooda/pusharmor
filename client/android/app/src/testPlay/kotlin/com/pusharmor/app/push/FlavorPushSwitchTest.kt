package com.pusharmor.app.push

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A switch from UnifiedPush back to Google drops the "no UnifiedPush app" flag, so the cannot-receive card goes away. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class FlavorPushSwitchTest {
    private val savedInit = FlavorPush.autoInit
    private val savedFetch = FlavorPush.fetchToken
    private val savedInstalled = UnifiedPushSupport.installed
    @After fun restore() { FlavorPush.autoInit = savedInit; FlavorPush.fetchToken = savedFetch; UnifiedPushSupport.installed = savedInstalled }

    private val app = ApplicationProvider.getApplicationContext<PaApp>()

    private fun setUp() {
        FlavorPush.autoInit = { }
        FlavorPush.fetchToken = { cb -> cb("token-1") }
        UnifiedPushSupport.installed = { emptyList() }
        val s = app.graph.settings
        // Same token as before the switch to UnifiedPush.
        s.set(Settings.K.PUSH_TOKEN, "token-1")
        s.set(Settings.K.PUSH_TYPE, "unifiedpush")
        s.set(Settings.K.BANNER, "no_distributor")
    }

    @Test fun switchToGoogleClearsTheCard() {
        setUp()
        val s = app.graph.settings
        assert(UnifiedPushSupport.noPushApp(app, s.get(Settings.K.PUSH_TYPE), playServices = true))
        FlavorPush(app).switchToGoogle(app.graph)
        assertNull(s.get(Settings.K.BANNER))
        assertEquals("fcm", s.get(Settings.K.PUSH_TYPE))
        assertFalse(UnifiedPushSupport.noPushApp(app, s.get(Settings.K.PUSH_TYPE), playServices = true))
    }

    /** The switch to Google sends the token even when it equals the one stored before the switch. */
    @Test fun switchToGoogleSendsAnEqualToken() {
        setUp()
        val wm = androidx.work.WorkManager.getInstance(app)
        wm.cancelUniqueWork("push-patch").result.get(); wm.pruneWork().result.get()
        var sentToken: String? = "unset"
        FlavorPush.fetchToken = { cb -> sentToken = app.graph.settings.get(Settings.K.PUSH_TOKEN); cb("token-1") }
        FlavorPush(app).switchToGoogle(app.graph)
        assertNull(sentToken) // cleared before the fetch, so onToken sees a new token and PATCHes
        assertEquals("token-1", app.graph.settings.get(Settings.K.PUSH_TOKEN))
        assertFalse(wm.getWorkInfosForUniqueWork("push-patch").get().isEmpty())
    }

    /** A Google token that cannot be fetched on the switch to Google says the setting could not be changed. */
    @Test fun failedTokenFetchOnSwitchSaysSo() {
        setUp()
        FlavorPush.fetchToken = savedFetch
        val savedTask = FlavorPush.tokenTask
        FlavorPush.tokenTask = { com.google.android.gms.tasks.Tasks.forException(java.io.IOException("SERVICE_NOT_AVAILABLE")) }
        try {
            val vm = com.pusharmor.app.ui.AppViewModel(app)
            vm.choosePush(com.pusharmor.app.ui.PUSH_GOOGLE)
            val end = System.currentTimeMillis() + 5000
            while (vm.message.value == null && System.currentTimeMillis() < end) { Thread.sleep(20); org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle() }
            assertEquals(com.pusharmor.net.ErrorText.text(com.pusharmor.app.ui.UiText.UNABLE_CHANGE_SETTING, com.pusharmor.net.ErrorText.TRY_AGAIN), vm.message.value)
        } finally { FlavorPush.tokenTask = savedTask }
    }

    @Test fun tokenOnOpenClearsAStaleFlag() {
        setUp()
        val s = app.graph.settings
        s.set(Settings.K.PUSH_TYPE, null)
        FlavorPush(app).onToken(app.graph, "token-1")
        assertNull(s.get(Settings.K.BANNER))
        assertEquals("fcm", s.get(Settings.K.PUSH_TYPE))
    }
}
