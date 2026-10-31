package com.pusharmor.app.data

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** A corrupt settings file resets to defaults instead of crashing every launch (I548). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class SettingsCorruptTest {
    @Test fun corruptFileResetsToDefaults() {
        val ctx = ApplicationProvider.getApplicationContext<android.app.Application>()
        val f = File(ctx.filesDir, "datastore/settings.preferences_pb")
        f.parentFile!!.mkdirs(); f.writeBytes(byteArrayOf(0x0a, 0x7f, 0x01, 0x02, 0x03))
        val s = Settings(ctx)
        assertNull(s.get(Settings.K.CH_MESSAGES))
        s.set(Settings.K.CH_MESSAGES, "m1")
        assertEquals("m1", s.get(Settings.K.CH_MESSAGES))
    }
}
