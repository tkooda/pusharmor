package com.pusharmor.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A settings screen that no app can open must not crash the app. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SafeStartTest {
    @Test fun noAppForTheIntentIsIgnored() {
        var tried = 0
        val ctx: Context = object : ContextWrapper(ApplicationProvider.getApplicationContext<PaApp>()) {
            override fun startActivity(intent: Intent) { tried++; throw ActivityNotFoundException("none") }
        }
        safeStart(ctx, Intent("android.settings.APP_NOTIFICATION_SETTINGS"))
        assertEquals(1, tried)
    }
}
