package com.pusharmor.protocol

/** Pairing timeout and countdown text (catalog Pairing flow step 8). */
object Countdown {
    const val PAIRING_TIMEOUT_MS = 14L * 24 * 3600 * 1000
    const val NO_REPLY_HINT_MS = 3L * 24 * 3600 * 1000
    const val SEND_AGAIN_GREY_MS = 60_000L
    private const val HOUR = 3600_000L
    private const val DAY = 24 * HOUR
    private const val MINUTE = 60_000L

    fun expired(startedAt: Long, now: Long): Boolean = now - startedAt >= PAIRING_TIMEOUT_MS

    /**
     * "X days" at 24 h or more left, "X hours" under 24 h, "X minutes" under 60 min.
     * Whole units, rounded down; under one minute shows "1 minutes" until expiry.
     */
    fun format(startedAt: Long, now: Long): String {
        val left = startedAt + PAIRING_TIMEOUT_MS - now
        return when {
            left >= DAY -> "${left / DAY} days"
            left >= HOUR -> "${left / HOUR} hours"
            else -> "${maxOf(1L, left / MINUTE)} minutes"
        }
    }
}
