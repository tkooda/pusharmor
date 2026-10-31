package com.pusharmor.app.data

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.notify.Policy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** "Always hide content" became "Show message content in notifications", inverted (I600). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class ShowContentMigrationTest {
    private fun settings(): Settings {
        val ctx = ApplicationProvider.getApplicationContext<android.app.Application>()
        return Settings(ctx).also { it.set(Settings.K.HIDE_CONTENT, null); it.set(Settings.K.SHOW_CONTENT, null) } // the DataStore is shared across tests
    }

    @Test fun oldTrueBecomesShowFalse() {
        val s = settings()
        s.set(Settings.K.HIDE_CONTENT, true)
        s.migrateShowContent()
        assertEquals(false, s.get(Settings.K.SHOW_CONTENT))
        assertFalse(s.showContent)
        assertNull(s.get(Settings.K.HIDE_CONTENT))
    }

    @Test fun oldFalseBecomesShowTrue() {
        val s = settings()
        s.set(Settings.K.HIDE_CONTENT, false)
        s.migrateShowContent()
        assertEquals(true, s.get(Settings.K.SHOW_CONTENT))
        assertNull(s.get(Settings.K.HIDE_CONTENT))
    }

    @Test fun absentDefaultsToShow() {
        val s = settings()
        s.migrateShowContent()
        assertNull(s.get(Settings.K.SHOW_CONTENT))
        assertTrue(s.showContent)
    }

    @Test fun newValueWinsOverStaleOldKey() {
        val s = settings()
        s.set(Settings.K.SHOW_CONTENT, true)
        s.set(Settings.K.HIDE_CONTENT, true)
        s.migrateShowContent()
        assertTrue(s.showContent)
        assertNull(s.get(Settings.K.HIDE_CONTENT))
    }

    @Test fun contentOffHidesEvenWhenLockScreenIsOn() {
        val hidden = Policy.of(true, true, true, true, !false, false)
        assertTrue(hidden.hideAll)
        assertFalse(hidden.privateOnLockScreen)
        assertFalse(Policy.of(true, true, true, true, !true, false).hideAll)
    }
}
