package com.pusharmor.protocol

/**
 * Device name rule. Allowed: ASCII 32..126 except ` \ " { } < > | ! $ ; ?, 1 to 32 characters, no leading "-".
 * Lengths and positions count code points. Spaces (0x20 only) are trimmed at both ends and runs of them become one;
 * nothing is padded.
 */
object DeviceName {
    const val TOO_SHORT = "Name too short"
    const val INVALID = "Invalid characters"
    const val MAX = 32
    private const val BAD = "`\\\"{}<>|!$;?"
    private val SPACES = Regex(" +")

    /** A typed name checked: [error] null and the [name] to save, or the error text and no name. */
    data class Checked(val error: String?, val name: String?)

    private fun allowed(cp: Int): Boolean = cp in 0x20..0x7e && cp.toChar() !in BAD

    /** Trims leading and trailing spaces and collapses each run of spaces to one. */
    private fun squeeze(s: String): String = s.replace(SPACES, " ").removePrefix(" ").removeSuffix(" ")

    private fun cps(s: String): List<String> = s.codePoints().toArray().map { String(Character.toChars(it)) }

    /** A typed name (rename): spaces cleaned first; the cleaned name when valid, else "Name too short" or "Invalid characters". */
    fun check(s: String): Checked {
        val name = squeeze(s)
        val cps = name.codePoints().toArray()
        if (cps.isEmpty()) return Checked(TOO_SHORT, null)
        if (cps.size > MAX || cps[0] == '-'.code || cps.any { !allowed(it) }) return Checked(INVALID, null)
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

    /** A received or stored name as shown: disallowed characters become ?, spaces are cleaned, a leading "-" becomes ?, empty shows ?. */
    fun display(s: String): String {
        val mapped = s.codePoints().toArray().joinToString("") { if (allowed(it)) it.toChar().toString() else "?" }
        val out = cps(squeeze(mapped)).toMutableList()
        if (out.isEmpty()) return "?"
        if (out[0] == "-") out[0] = "?"
        return out.joinToString("")
    }
}
