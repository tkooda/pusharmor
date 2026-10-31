package com.pusharmor.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CountdownTest {
    private val h = 3600_000L
    private val start = 1_000_000L

    @Test fun formats() {
        assertEquals("30 days", Countdown.format(start, start))
        assertEquals("1 days", Countdown.format(start, start + Countdown.PAIRING_TIMEOUT_DAYS * 24 * h - 24 * h))
        assertEquals("23 hours", Countdown.format(start, start + Countdown.PAIRING_TIMEOUT_DAYS * 24 * h - 24 * h + 1))
        assertEquals("1 hours", Countdown.format(start, start + Countdown.PAIRING_TIMEOUT_DAYS * 24 * h - h))
        assertEquals("59 minutes", Countdown.format(start, start + Countdown.PAIRING_TIMEOUT_DAYS * 24 * h - h + 1))
        assertEquals("1 minutes", Countdown.format(start, start + Countdown.PAIRING_TIMEOUT_DAYS * 24 * h - 1))
    }

    @Test fun expiry() {
        assertFalse(Countdown.expired(start, start + 29 * 24 * h))
        assertTrue(Countdown.expired(start, start + Countdown.PAIRING_TIMEOUT_DAYS * 24 * h))
    }
}
