package com.pusharmor.app.push

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The no-push-app card shows only while UnifiedPush is the push method and no UnifiedPush app is installed now. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class NoPushAppTest {
    private val saved = UnifiedPushSupport.installed
    @After fun restore() { UnifiedPushSupport.installed = saved }
    private val app = ApplicationProvider.getApplicationContext<PaApp>()

    @Test fun visibilityRule() {
        UnifiedPushSupport.installed = { emptyList() }
        assertTrue(UnifiedPushSupport.noPushApp(app, "unifiedpush", playServices = true))
        assertTrue(UnifiedPushSupport.noPushApp(app, null, playServices = false))
        assertFalse(UnifiedPushSupport.noPushApp(app, "fcm", playServices = true))
        assertFalse(UnifiedPushSupport.noPushApp(app, null, playServices = true))
        UnifiedPushSupport.installed = { listOf("io.heckel.ntfy") }
        assertFalse(UnifiedPushSupport.noPushApp(app, "unifiedpush", playServices = true))
        assertFalse(UnifiedPushSupport.noPushApp(app, null, playServices = false))
    }
}
