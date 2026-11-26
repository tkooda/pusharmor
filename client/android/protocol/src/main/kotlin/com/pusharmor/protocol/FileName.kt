package com.pusharmor.protocol

import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * File names, applied by sender and receiver alike: an ASCII allow-list, a fallback name, reserved device
 * names, and "base (N).ext" on a collision.
 */
object FileName {
    /** Longest file name in a toast or error; a longer one is cut in the middle (see [cut]). */
    const val CUT_MAX = 24

    /** [name] cut in the middle to [CUT_MAX] characters: its first 14, "...", and its last 7 (the extension). */
    fun cut(name: String): String = if (name.length <= CUT_MAX) name else name.take(14) + "..." + name.takeLast(7)

    private val RESERVED = setOf("CON", "PRN", "AUX", "NUL") + (1..9).flatMap { listOf("COM$it", "LPT$it") }
    private val EXT = Regex("[A-Za-z0-9]{1,10}")
    private val ALNUM = Regex("[A-Za-z0-9]")
    private val STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

    private fun allowed(cp: Int) = cp in 'A'.code..'Z'.code || cp in 'a'.code..'z'.code || cp in '0'.code..'9'.code || cp == ' '.code || cp == '.'.code || cp == '_'.code || cp == '('.code || cp == ')'.code || cp == '-'.code

    /** base and ".ext" when the text after the last dot is 1-10 ASCII letters or digits, else name and "". */
    fun splitExt(name: String): Pair<String, String> {
        val i = name.lastIndexOf('.')
        if (i >= 0 && EXT.matches(name.substring(i + 1))) return name.substring(0, i) to name.substring(i)
        return name to ""
    }

    /** The file name rule. [timeSec]: Unix seconds for a fallback name (send time, or receive time on a receiver). */
    fun sanitize(input: String, timeSec: Long, image: Boolean): String {
        val last = input.split('/', '\\').last()
        val sb = StringBuilder()
        last.codePoints().forEach { cp -> if (allowed(cp)) sb.appendCodePoint(cp) else sb.append('_') }
        var name = sb.toString().replace(Regex("_+"), "_").replace(Regex(" +"), " ").trim(' ', '.')
        var (base, ext) = splitExt(name)
        if (!ALNUM.containsMatchIn(base) || base.length > 64) {
            base = (if (image) "image-" else "file-") + LocalDateTime.ofEpochSecond(timeSec, 0, ZoneOffset.UTC).format(STAMP)
        }
        name = (base + ext).take(100)
        if (name.substringBefore('.').trimEnd(' ').uppercase() in RESERVED) name = "_$name"
        return name
    }

    /** [name], or "base (N).ext" with the smallest free N >= 1. Names match ignoring ASCII case. */
    fun collide(name: String, existing: Iterable<String>): String {
        val taken = existing.map { it.lowercase() }.toHashSet()
        if (name.lowercase() !in taken) return name
        val (base, ext) = splitExt(name)
        var n = 1
        while (true) {
            val c = "$base ($n)$ext"
            if (c.lowercase() !in taken) return c
            n++
        }
    }
}
