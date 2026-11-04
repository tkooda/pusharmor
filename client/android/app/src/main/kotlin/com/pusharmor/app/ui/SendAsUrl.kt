package com.pusharmor.app.ui

import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Detect

/** The "Send as URL" rule, the same on every client: does the trimmed message look like a web address? */
object LikelyUrl {
    private val LABEL = Regex("[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
    private val TLD = Regex("[A-Za-z]{2,}|xn--[A-Za-z0-9-]*")

    fun check(text: String): Boolean {
        val t = text.trim()
        if (t.isEmpty() || t.any { it.isWhitespace() }) return false
        // An http or https scheme with anything after it is always likely; the host check is for text without one.
        val n = schemeLength(t)
        if (n >= 0) return t.length > n
        // Any other scheme ("ftp://") leaves a ":" in the host part with a non-digit port, so it fails below.
        val end = t.indexOfFirst { it == '/' || it == '?' || it == '#' || it == ':' }.let { if (it < 0) t.length else it }
        if (end < t.length && t[end] == ':') {
            val portEnd = t.indexOfFirst(end + 1) { it == '/' || it == '?' || it == '#' }
            val port = t.substring(end + 1, portEnd)
            if (port.isEmpty() || !port.all { it in '0'..'9' }) return false
        }
        val labels = t.substring(0, end).split('.')
        if (labels.size < 2 || labels.any { !LABEL.matches(it) }) return false
        return TLD.matches(labels.last())
    }

    /** The message as a URL: trimmed, with "https://" added when it has no http or https scheme. */
    fun asUrl(text: String): String {
        val t = text.trim()
        return if (schemeLength(t) < 0) "https://$t" else t
    }

    /** Length of a leading "http://" or "https://" (any case), else -1. */
    private fun schemeLength(t: String): Int = when {
        t.startsWith("http://", ignoreCase = true) -> 7
        t.startsWith("https://", ignoreCase = true) -> 8
        else -> -1
    }

    private inline fun String.indexOfFirst(from: Int, p: (Char) -> Boolean): Int {
        for (i in from until length) if (p(this[i])) return i
        return length
    }
}

/**
 * What the Send screen sends. The type is detected from the text: a likely URL wins over a phone number, else text.
 * "Send as text" (unchecked at first) overrides a detected URL or phone number to text for one send; it is never saved.
 */
object SendAsUrl {
    /** The detected type of [text]. */
    fun detected(text: String): ContentType = when {
        LikelyUrl.check(text) -> ContentType.URL
        Detect.type(text) == ContentType.TEL -> ContentType.TEL
        else -> ContentType.TEXT
    }

    /** "Send as text" is offered only when a URL or a phone number is detected. */
    fun offersText(text: String): Boolean = detected(text) != ContentType.TEXT

    /** The type this send carries: the detected one, or text when [asText] is checked. */
    fun effective(text: String, asText: Boolean): ContentType = if (asText) ContentType.TEXT else detected(text)

    /** The "Send as text" box after the message changed: a change of the detected type resets it to unchecked. */
    fun afterEdit(old: String, new: String, asText: Boolean): Boolean = asText && detected(old) == detected(new) && offersText(new)

    /** What a send carries: the URL (https added when it has no scheme), the phone number, or the text as typed. */
    fun content(text: String, asText: Boolean): Pair<ContentType, String> = when (effective(text, asText)) {
        ContentType.URL -> ContentType.URL to LikelyUrl.asUrl(text)
        ContentType.TEL -> ContentType.TEL to text.trim()
        ContentType.TEXT -> ContentType.TEXT to text
    }
}
