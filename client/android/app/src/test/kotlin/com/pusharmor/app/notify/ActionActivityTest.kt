package com.pusharmor.app.notify

import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A notification tap must not crash (I546): the activity finishes after onResume. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class ActionActivityTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun tap(act: String): ActionActivity {
        val ctx = ApplicationProvider.getApplicationContext<PaApp>()
        val i = Intent(ctx, ActionActivity::class.java).putExtra("history", 1L).putExtra("act", act)
        val a = Robolectric.buildActivity(ActionActivity::class.java, i).setup().get()
        val end = System.currentTimeMillis() + 5000
        while (!a.isFinishing && System.currentTimeMillis() < end) { Thread.sleep(20); idle() }
        return a
    }

    @Test fun tapFinishesWithoutCrash() {
        assertTrue(tap("item").isFinishing)
        assertTrue(shadowOf(ApplicationProvider.getApplicationContext<PaApp>()).nextStartedActivity != null)
    }
}
