package com.pusharmor.app

import com.pusharmor.app.ui.theme.ThemePref
import org.junit.Assert.assertEquals
import org.junit.Test

class ThemePrefTest {
    @Test fun parseDefaultsToSystem() {
        assertEquals(ThemePref.SYSTEM, ThemePref.parse(null))
        assertEquals(ThemePref.SYSTEM, ThemePref.parse(""))
        assertEquals(ThemePref.SYSTEM, ThemePref.parse("sepia"))
        assertEquals(ThemePref.LIGHT, ThemePref.parse("light"))
        assertEquals(ThemePref.DARK, ThemePref.parse("dark"))
    }

    @Test fun resolvesDark() {
        assertEquals(true, ThemePref.SYSTEM.isDark(true))
        assertEquals(false, ThemePref.SYSTEM.isDark(false))
        assertEquals(false, ThemePref.LIGHT.isDark(true))
        assertEquals(true, ThemePref.DARK.isDark(false))
    }
}
