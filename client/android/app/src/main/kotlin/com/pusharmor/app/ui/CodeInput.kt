package com.pusharmor.app.ui

/** Email code entry rules (batch5 ruling): Crockford alphabet, uppercase, O->0, I/L->1. */
object CodeInput {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** Uppercase, map O->0 and I/L->1, drop chars outside the alphabet, cap at 6. */
    fun clean(raw: String): String {
        val sb = StringBuilder()
        for (c0 in raw.uppercase()) {
            val c = when (c0) { 'O' -> '0'; 'I', 'L' -> '1'; else -> c0 }
            if (c in ALPHABET) sb.append(c)
            if (sb.length == 6) break
        }
        return sb.toString()
    }

    /**
     * Paste: take a standalone 6-char token (inner dashes or spaces allowed), else null.
     * "Code: 7KQ-M9X." gives 7KQM9X; a longer run of code chars gives null.
     */
    fun fromPaste(text: String): String? {
        val tokens = Regex("[A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9]|[A-Za-z0-9]").findAll(text).map { it.value }
        for (t in tokens) {
            val parts = t.split(' ', '-').filter { it.isNotEmpty() }
            val joined = parts.joinToString("")
            if (joined.length == 6) {
                val c = clean(joined)
                if (c.length == 6) return c
            }
            for (p in parts) if (p.length == 6 && clean(p).length == 6) return clean(p)
        }
        return null
    }
}
