package com.pusharmor.protocol

/** Pairing timeout and countdown text (catalog Pairing flow step 8). */
object Countdown {
    const val PAIRING_TIMEOUT_DAYS = 14L
    private const val HOUR = 3600_000L
    private const val DAY = 24 * HOUR
    private const val MINUTE = 60_000L

    /** A start later than [now] (a clock that was set ahead) counts as [now]. */
    fun expired(startedAt: Long, now: Long): Boolean = now - minOf(startedAt, now) >= PAIRING_TIMEOUT_DAYS * DAY

    /**
     * "X days" at 24 h or more left, "X hours" under 24 h, "X minutes" under 60 min.
     * Whole units, rounded down; under one minute shows "1 minutes" until expiry.
     */
    fun format(startedAt: Long, now: Long): String {
        val left = minOf(startedAt, now) + PAIRING_TIMEOUT_DAYS * DAY - now
        return when {
            left >= DAY -> "${left / DAY} days"
            left >= HOUR -> "${left / HOUR} hours"
            else -> "${maxOf(1L, left / MINUTE)} minutes"
        }
    }
}
