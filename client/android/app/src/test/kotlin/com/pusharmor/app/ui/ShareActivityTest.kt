package com.pusharmor.app.ui

import android.content.Intent
import android.text.SpannableString
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.TestApp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A share of styled text (a CharSequence extra) opens the share sheet; a share with no text closes it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class ShareActivityTest {
    private fun launch(extra: (Intent) -> Unit): ShareActivity {
        val i = Intent(ApplicationProvider.getApplicationContext(), ShareActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
        extra(i)
        return Robolectric.buildActivity(ShareActivity::class.java, i).create().get()
    }

    /**
     * The update screen holds the sheet open whatever the background read's timing: a device with no log in
     * would otherwise close it as soon as that read returns. A text the sheet could not read closes it at once.
     */
    @Test fun styledTextShareStaysOpen() {
        val s = ApplicationProvider.getApplicationContext<com.pusharmor.app.PaApp>().graph.settings
        s.markUpdateRequired(com.pusharmor.app.BuildConfig.VERSION_NAME)
        try {
            assertFalse(launch { it.putExtra(Intent.EXTRA_TEXT, SpannableString("hello")) }.isFinishing)
        } finally { s.set(com.pusharmor.app.data.Settings.K.UPDATE_REQUIRED, null) }
    }

    /** A share on a damaged database opens the app, which shows the data screen, instead of crashing. */
    @Test fun shareOnCorruptDatabaseOpensTheApp() {
        val app = ApplicationProvider.getApplicationContext<com.pusharmor.app.PaApp>()
        com.pusharmor.app.corruptDatabase(app)
        val a = launch { it.putExtra(Intent.EXTRA_TEXT, "hello") }
        val end = System.currentTimeMillis() + 5000
        while (!a.isFinishing && System.currentTimeMillis() < end) { Thread.sleep(20); org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle() }
        assertTrue(a.isFinishing)
        assertEquals(MainActivity::class.java.name, org.robolectric.Shadows.shadowOf(app).nextStartedActivity.component?.className)
    }

    @Test fun shareWithoutTextCloses() {
        assertTrue(launch { }.isFinishing)
    }
}
