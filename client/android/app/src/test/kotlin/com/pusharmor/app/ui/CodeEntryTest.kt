package com.pusharmor.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A code is sent when the sixth digit arrives, and not again by a keystroke past it. */
class CodeEntryTest {
    @Test fun sixthDigitSends() = assertTrue(shouldSubmit("12345", "123456"))
    @Test fun seventhKeystrokeDoesNotSendAgain() = assertFalse(shouldSubmit("123456", "123456"))
    /** The step bar: each new caption is the next step, the same caption again is not, and it stops at the last. */
    @Test fun stepBarCountsCaptions() {
        assertEquals(1 to 3, nextStep(0 to 3, null, "Checking the code"))
        assertEquals(2 to 3, nextStep(1 to 3, "Checking the code", "Setting up this device"))
        assertEquals(2 to 3, nextStep(2 to 3, "Setting up this device", "Setting up this device"))
        assertEquals(2 to 2, nextStep(2 to 2, "Removing", "Logging in"))
    }

    @Test fun shortCodeDoesNotSend() = assertFalse(shouldSubmit("1234", "12345"))
    @Test fun pasteOfSixSends() = assertTrue(shouldSubmit("", "123456"))
}
