package com.pusharmor.app.push

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A wipe turns off FCM's automatic token fetch, so the device gets no new token after it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class FlavorPushStopTest {
    private val saved = FlavorPush.autoInit
    @After fun restore() { FlavorPush.autoInit = saved }

    @Test fun stopDisablesAutoInit() {
        val calls = mutableListOf<Boolean>()
        FlavorPush.autoInit = { calls += it }
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        FlavorPush(app).stop(app.graph)
        assertEquals(listOf(false), calls)
    }
}
