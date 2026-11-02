package com.pusharmor.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A code is sent when the sixth digit arrives, and not again by a keystroke past it. */
class CodeEntryTest {
    @Test fun sixthDigitSends() = assertTrue(shouldSubmit("12345", "123456"))
    @Test fun seventhKeystrokeDoesNotSendAgain() = assertFalse(shouldSubmit("123456", "123456"))
    @Test fun shortCodeDoesNotSend() = assertFalse(shouldSubmit("1234", "12345"))
    @Test fun pasteOfSixSends() = assertTrue(shouldSubmit("", "123456"))
}
