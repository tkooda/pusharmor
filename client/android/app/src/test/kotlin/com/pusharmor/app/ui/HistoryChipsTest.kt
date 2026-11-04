package com.pusharmor.app.ui

import com.pusharmor.app.notify.HistoryFilter.Chip
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** History chips: Sent and Received turn All off; clearing both turns it back on; All clears the others. */
class HistoryChipsTest {
    @Test fun startsWithAllOn() = assertTrue(allChipOn(Chip.All, emptyList()))

    @Test fun choosingSentOrReceivedTurnsAllOff() {
        assertFalse(allChipOn(Chip.All, toggleDirection(emptyList(), "SENT")))
        assertFalse(allChipOn(Chip.All, toggleDirection(emptyList(), "RECEIVED")))
    }

    @Test fun clearingBothTurnsAllOn() {
        var d = toggleDirection(toggleDirection(emptyList(), "SENT"), "RECEIVED")
        assertEquals(listOf("SENT", "RECEIVED"), d)
        d = toggleDirection(d, "SENT")
        assertFalse(allChipOn(Chip.All, d))
        d = toggleDirection(d, "RECEIVED")
        assertTrue(allChipOn(Chip.All, d))
    }

    @Test fun aDeviceChipTurnsAllOff() = assertFalse(allChipOn(Chip.PeerChip("a", "A"), emptyList()))

    @Test fun allChipSelectionIsHandledInTheScreen() {
        // Tapping All sets the device chip to All and clears both directions.
        val main = java.io.File("src/main/kotlin/com/pusharmor/app/ui/MainScreens.kt").readText()
        assertTrue(main.contains("if (c == HistoryFilter.Chip.All) dirs = emptyList()"))
    }
}
