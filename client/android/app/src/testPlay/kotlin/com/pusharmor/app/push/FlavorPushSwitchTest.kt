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
        // Same token as before the switch to UnifiedPush: no PATCH is queued.
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

    @Test fun tokenOnOpenClearsAStaleFlag() {
        setUp()
        val s = app.graph.settings
        s.set(Settings.K.PUSH_TYPE, null)
        FlavorPush(app).onToken(app.graph, "token-1")
        assertNull(s.get(Settings.K.BANNER))
        assertEquals("fcm", s.get(Settings.K.PUSH_TYPE))
    }
}
