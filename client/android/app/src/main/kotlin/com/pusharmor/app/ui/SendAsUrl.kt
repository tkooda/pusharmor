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
 * The "Send as URL" checkbox. It is enabled only while the message is a likely URL, and checks itself
 * then, unless the user unchecked it for this message. A send or an empty field starts over.
 */
data class SendAsUrl(val checked: Boolean = false, val optedOut: Boolean = false) {
    /** The message changed to [text]. */
    fun onText(text: String): SendAsUrl = when {
        text.isEmpty() -> SendAsUrl()
        !LikelyUrl.check(text) -> copy(checked = false)
        optedOut -> this
        else -> copy(checked = true)
    }

    /** The user tapped the enabled checkbox; an uncheck stops the automatic check for this message. */
    fun onToggle(on: Boolean): SendAsUrl = SendAsUrl(checked = on, optedOut = optedOut || !on)

    companion object {
        fun enabled(text: String): Boolean = LikelyUrl.check(text)
        fun start(text: String): SendAsUrl = SendAsUrl().onText(text)

        /** What a send carries: checked "Send as URL" a URL; else a phone number as before (unless "Send as text"); else text. */
        fun content(text: String, asUrl: Boolean, asText: Boolean): Pair<ContentType, String> = when {
            asUrl -> ContentType.URL to LikelyUrl.asUrl(text)
            !asText && Detect.type(text) == ContentType.TEL -> ContentType.TEL to text.trim()
            else -> ContentType.TEXT to text
        }
    }
}
