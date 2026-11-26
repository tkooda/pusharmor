package com.pusharmor.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

/** The setup default name gets " (2)", " (3)", ... when another known device has it, ignoring case. */
class DeviceNameUniqueTest {
    @Test fun freeNameStays() = assertEquals("Pixel 8", DeviceName.unique("Pixel 8", listOf("Laptop")))

    @Test fun takenNameGetsFirstFreeNumber() {
        assertEquals("Pixel 8 (2)", DeviceName.unique("Pixel 8", listOf("pixel 8")))
        assertEquals("Pixel 8 (3)", DeviceName.unique("Pixel 8", listOf("Pixel 8", "PIXEL 8 (2)")))
    }

    @Test fun longNameIsCutToFitAndLosesTheSpaceAtTheCut() {
        val base = "a".repeat(27) + " bcd" // 31
        assertEquals("a".repeat(27) + " (2)", DeviceName.unique(base, listOf(base)))
        val full = "x".repeat(32)
        assertEquals("x".repeat(28) + " (2)", DeviceName.unique(full, listOf(full)))
    }
}
