package com.pusharmor.protocol

import java.net.URI

/** User content types of the inner message. */
enum class ContentType(val key: String) { URL("url"), TEXT("text"), TEL("tel") }

object SizeCap {
    const val MAX_CONTENT_BYTES = 2048
    const val WIRE_CAP = 3800
    const val INFLATE_CAP = 16 * 1024

    fun utf8Size(s: String): Int = s.toByteArray(Charsets.UTF_8).size

    /** Counter is red at 90 pc of the cap. */
    fun isNearCap(s: String): Boolean = utf8Size(s) * 10 >= MAX_CONTENT_BYTES * 9

    /** First at most [max] bytes of [s], cut at a UTF-8 code point boundary. */
    fun truncateUtf8(s: String, max: Int = MAX_CONTENT_BYTES): String {
        var bytes = 0
        var k = 0
        while (k < s.length) {
            val cp = s.codePointAt(k)
            val len = when {
                cp < 0x80 -> 1
                cp < 0x800 -> 2
                cp < 0x10000 -> 3
                else -> 4
            }
            if (bytes + len > max) break
            bytes += len
            k += Character.charCount(cp)
        }
        return s.substring(0, k)
    }
}

/** Phone number detection (catalog, same rules on every platform). */
object Phone {
    private val PHONE = Regex("^\\+?(?:[ ().-]*[0-9]){7,15}[ ().-]*$")
    private val IPV4 = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")
    private val DATE = Regex("^([0-9]{4}([-. ])[0-9]{2}\\2[0-9]{2}|[0-9]{2}([-. ])[0-9]{2}\\3[0-9]{4})$")

    /** Trim TAB, LF, FF, CR, SPACE and NBSP only. */
    fun trim(s: String): String = s.trim { it == ' ' || it == '\t' || it == '\n' || it == '\r' || it == '\u000C' || it == '\u00a0' }

    /** Trim ASCII whitespace and NBSP; strip one leading "tel:". */
    fun normalize(s: String): String {
        var t = trim(s)
        if (t.startsWith("tel:")) t = t.substring(4)
        return t
    }

    fun isPhone(s: String): Boolean {
        val t = normalize(s)
        return PHONE.matches(t) && !IPV4.matches(t) && !DATE.matches(t)
    }
}

/** Strict received-URL check (catalog: one http(s) URL). */
object UrlCheck {
    class Parsed(val href: String, val host: String)

    /**
     * java.net.URI parse; scheme http or https (any case), non-empty host, no userinfo.
     * Returns null when the value is not one such URL (then shown as plain text).
     */
    fun parse(s: String): Parsed? {
        if (s.isEmpty() || s.any { it.code <= 0x20 || it.code == 0x7f }) return null
        val u = try { URI(toAsciiHost(s) ?: return null) } catch (e: Exception) { return null }
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (u.rawUserInfo != null) return null
        val host = u.host?.lowercase() ?: return null
        if (host.isEmpty()) return null
        val port = when {
            u.port == -1 -> ""
            scheme == "http" && u.port == 80 -> ""
            scheme == "https" && u.port == 443 -> ""
            else -> ":${u.port}"
        }
        val path = u.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        val href = buildString {
            append(scheme).append("://").append(host).append(port).append(path)
            u.rawQuery?.let { append('?').append(it) }
            u.rawFragment?.let { append('#').append(it) }
        }
        return Parsed(href, host)
    }
}

/**
 * Converts a non-ASCII host to punycode (IDNA, as WHATWG URL does) so java.net.URI can
 * parse it; other parts are left as given. Null when the host cannot be converted.
 */
private fun toAsciiHost(s: String): String? {
    if (s.all { it.code < 0x80 }) return s
    val sep = s.indexOf("://")
    if (sep < 0) return s
    val start = sep + 3
    var end = s.length
    for (k in start until s.length) if (s[k] == '/' || s[k] == '?' || s[k] == '#') { end = k; break }
    val authority = s.substring(start, end)
    if (authority.contains('@')) return s // userinfo: rejected by the parse
    val colon = authority.lastIndexOf(':')
    val host = if (colon >= 0 && !authority.contains(']')) authority.substring(0, colon) else authority
    val port = authority.substring(host.length)
    val ascii = try { java.net.IDN.toASCII(host, java.net.IDN.ALLOW_UNASSIGNED) } catch (e: Exception) { return null }
    return s.substring(0, start) + ascii.lowercase() + port + s.substring(end)
}

/** Type detection for sending: tel: URI > one http(s) URL > phone pattern > text. */
object Detect {
    fun type(raw: String): ContentType {
        val trimmed = Phone.trim(raw)
        if (trimmed.startsWith("tel:") && Phone.isPhone(trimmed)) return ContentType.TEL
        if (UrlCheck.parse(trimmed) != null) return ContentType.URL
        if (Phone.isPhone(trimmed)) return ContentType.TEL
        return ContentType.TEXT
    }
}
