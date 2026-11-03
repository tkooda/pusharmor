package com.pusharmor.app.ui

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A notification tap that arrives during a launcher start ends the plain launch, so it does not land on Send. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class PlainLaunchTest {
    @Test fun newIntentEndsThePlainLaunch() {
        val ctx = ApplicationProvider.getApplicationContext<PaApp>()
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setClass(ctx, MainActivity::class.java)
        val c = Robolectric.buildActivity(MainActivity::class.java, launcher).create()
        val vm = androidx.lifecycle.ViewModelProvider(c.get())[AppViewModel::class.java]
        val end = System.currentTimeMillis() + 5000 // the start check finishes before the activity goes
        while (vm.start.value == null && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(android.os.Looper.getMainLooper()).idle() }
        try {
            assertTrue(MainActivity.plainLaunch)
            c.newIntent(MainActivity.openIntent(ctx, "history").putExtra("history", 1L))
            assertFalse(MainActivity.plainLaunch)
        } finally { MainActivity.plainLaunch = false; MainActivity.pendingRoute = null; c.destroy() }
    }
}
