package com.pusharmor.app.ui

import android.content.Intent
import android.text.SpannableString
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.TestApp
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

    @Test fun styledTextShareStaysOpen() {
        assertFalse(launch { it.putExtra(Intent.EXTRA_TEXT, SpannableString("hello")) }.isFinishing)
    }

    @Test fun shareWithoutTextCloses() {
        assertTrue(launch { }.isFinishing)
    }
}
