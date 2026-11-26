package com.pusharmor.protocol

/**
 * Device name rule. Allowed: ASCII 32..126 except ` \ " { } < > | ! $ ; ?, 1 to 32 characters, no leading "-".
 * Lengths and positions count code points. Spaces (0x20 only) are trimmed at both ends and runs of them become one;
 * nothing is padded.
 */
object DeviceName {
    const val TOO_SHORT = "Name too short"
    const val INVALID = "Invalid characters"
    const val TOO_LONG = "Name too long\nUse 32 characters or fewer"
    const val MAX = 32
    private const val BAD = "`\\\"{}<>|!$;?"
    private val SPACES = Regex(" +")

    /** A typed name checked: [error] null and the [name] to save, or the error text and no name. */
    data class Checked(val error: String?, val name: String?)

    private fun allowed(cp: Int): Boolean = cp in 0x20..0x7e && cp.toChar() !in BAD

    /** Trims leading and trailing spaces and collapses each run of spaces to one. */
    private fun squeeze(s: String): String = s.replace(SPACES, " ").removePrefix(" ").removeSuffix(" ")

    private fun cps(s: String): List<String> = s.codePoints().toArray().map { String(Character.toChars(it)) }

    /**
     * A typed name (rename): spaces cleaned first; the cleaned name when valid, else "Name too short", "Name too long"
     * (over 32, checked before the characters), or "Invalid characters".
     */
    fun check(s: String): Checked {
        val name = squeeze(s)
        val cps = name.codePoints().toArray()
        if (cps.isEmpty()) return Checked(TOO_SHORT, null)
        if (cps.size > MAX) return Checked(TOO_LONG, null)
        if (cps[0] == '-'.code || cps.any { !allowed(it) }) return Checked(INVALID, null)
        return Checked(null, name)
    }

    /** The error text for a typed name, or null when it is valid. */
    fun inputError(s: String): String? = check(s).error

    /**
     * The first name from the system name: curly apostrophes become ', every other disallowed character becomes ?,
     * spaces are cleaned, a leading "-" becomes ?, then at most 32 with no trailing space. May be empty.
     */
    fun setupDefault(s: String): String {
        val mapped = s.codePoints().toArray().joinToString("") { cp ->
            when {
                cp == 0x2018 || cp == 0x2019 -> "'"
                allowed(cp) -> cp.toChar().toString()
                else -> "?"
            }
        }
        val out = cps(squeeze(mapped)).toMutableList()
        if (out.firstOrNull() == "-") out[0] = "?"
        return squeeze(out.take(MAX).joinToString(""))
    }

    /** ASCII case fold: only A-Z change. */
    fun fold(s: String): String = buildString(s.length) { for (c in s) append(if (c in 'A'..'Z') c + 32 else c) }

    /**
     * [name] unchanged when no name of [taken] equals it ignoring ASCII case, else with the smallest free " (N)", N >= 2.
     * The base is cut so the result stays within 32, and spaces left at the cut go before the suffix.
     */
    fun unique(name: String, taken: Collection<String>): String {
        val used = taken.map(::fold).toSet()
        if (fold(name) !in used) return name
        var k = 2
        while (true) {
            val suffix = " ($k)"
            val c = cps(name).take(MAX - suffix.length).joinToString("").trimEnd(' ') + suffix
            if (fold(c) !in used) return c
            k++
        }
    }

    /** A received or stored name as shown: disallowed characters become ?, spaces are cleaned, a leading "-" becomes ?, empty shows ?. */
    fun display(s: String): String {
        val mapped = s.codePoints().toArray().joinToString("") { if (allowed(it)) it.toChar().toString() else "?" }
        val out = cps(squeeze(mapped)).toMutableList()
        if (out.isEmpty()) return "?"
        if (out[0] == "-") out[0] = "?"
        return out.joinToString("")
    }
}
