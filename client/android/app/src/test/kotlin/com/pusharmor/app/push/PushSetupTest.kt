package com.pusharmor.app.push

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.FailedReason

/** A UnifiedPush registration that fails, or an address without usable keys, shows on the cannot-receive card until an address arrives. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class PushSetupTest {
    private val savedApp = UnifiedPushSupport.saved
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val g get() = app.graph
    private val keys = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4" to "BTBZMqHH6r4Tts7J_aSIgg"

    @Before fun setUp() {
        UnifiedPushSupport.saved = { "io.heckel.ntfy" }
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
    }
    @After fun restore() {
        UnifiedPushSupport.saved = savedApp
        g.settings.set(Settings.K.PUSH_SETUP, null)
        UnifiedPushSupport.clearEndpoint(g)
        g.settings.set(Settings.K.PUSH_TYPE, null)
    }

    private fun line2(): String? = UnifiedPushSupport.setupError(app, runBlocking { g.settings.data.first() }, playServices = true)

    @Test fun failedRegistrationSaysSoUntilAnAddressArrives() {
        Robolectric.buildService(UpService::class.java).create().get().onRegistrationFailed(FailedReason.NETWORK, UnifiedPushSupport.INSTANCE)
        assertEquals("\"io.heckel.ntfy\" could not turn on messages for PushArmor. Open \"io.heckel.ntfy\", then tap Check again.", line2())
        UnifiedPushSupport.onNewEndpoint(g, "https://push.example.org/up/a", keys.first, keys.second)
        assertNull(line2())
    }

    @Test fun addressWithoutKeysSaysSoUntilAGoodOneArrives() {
        UnifiedPushSupport.onNewEndpoint(g, "https://push.example.org/up/a", null, keys.second)
        assertEquals("\"io.heckel.ntfy\" gave an address PushArmor cannot use. Update \"io.heckel.ntfy\", or choose another UnifiedPush app.", line2())
        assertNull(g.settings.get(Settings.K.UP_ENDPOINT))
        UnifiedPushSupport.onNewEndpoint(g, "https://push.example.org/up/a", keys.first, "not base64!")
        assertEquals("up_keys", g.settings.get(Settings.K.PUSH_SETUP))
        UnifiedPushSupport.onNewEndpoint(g, "https://push.example.org/up/a", keys.first, keys.second)
        assertNull(line2())
    }

    /** A Google token failure is not shown while UnifiedPush is the method, nor a UnifiedPush failure on Google. */
    @Test fun onlyTheMethodInUseShows() {
        g.settings.set(Settings.K.PUSH_SETUP, "fcm_token")
        assertNull(line2())
        g.settings.set(Settings.K.PUSH_TYPE, "fcm")
        assertEquals("Google's push service did not answer. Check your internet connection, then tap Check again.", line2())
        g.settings.set(Settings.K.PUSH_SETUP, "up_register")
        assertNull(line2())
    }
}
