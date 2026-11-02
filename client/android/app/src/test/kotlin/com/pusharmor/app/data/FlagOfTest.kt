package com.pusharmor.app.data

import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import org.junit.Assert.assertEquals
import org.junit.Test

/** Screens read flags from the loaded snapshot, never by blocking on the data store. */
class FlagOfTest {
    @Test fun defaultsUntilLoadedOrSet() {
        assertEquals(true, Settings.flagOf(null, Settings.K.SHOW_CONTENT, true))
        assertEquals(true, Settings.flagOf(emptyPreferences(), Settings.K.SHOW_CONTENT, true))
        assertEquals(false, Settings.flagOf(emptyPreferences(), Settings.K.UP_VERIFIED, false))
    }

    @Test fun setValueWins() {
        val p = mutablePreferencesOf(Settings.K.SHOW_CONTENT to false, Settings.K.WATCH to true)
        assertEquals(false, Settings.flagOf(p, Settings.K.SHOW_CONTENT, true))
        assertEquals(true, Settings.flagOf(p, Settings.K.WATCH, false))
    }
}
