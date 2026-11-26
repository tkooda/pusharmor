package com.pusharmor.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A send chip too narrow for "Name (907-331-064)" cuts the name, never the ID. */
class ChipNameCutTest {
    private fun fits(n: Int): (String) -> Boolean = { it.length <= n }

    @Test fun longNameKeepsWholeId() {
        val label = "Thor's very long Pixel 8 Pro phone (907-331-064)"
        val shown = UiText.keepIdCut(label, fits(30))
        assertTrue(shown, shown.endsWith(" (907-331-064)"))
        assertTrue(shown, shown.contains("..."))
        assertEquals(30, shown.length)
        assertTrue(shown.startsWith("Thor's"))
    }

    @Test fun labelThatFitsOrHasNoIdIsUnchanged() {
        assertEquals("Pixel 8 (907-331-064)", UiText.keepIdCut("Pixel 8 (907-331-064)", fits(40)))
        val plain = "Thor's very long Pixel 8 Pro phone"
        assertEquals(plain, UiText.keepIdCut(plain, fits(10)))
    }
}
