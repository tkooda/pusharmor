package com.pusharmor.protocol

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

    private const val HOST_FORBIDDEN = " #%/:<>?@[\\]^|"
    private const val PATH_ENCODE = " \"#<>?`{}^"
    private const val QUERY_ENCODE = " \"#<>'"
    private const val FRAGMENT_ENCODE = " \"<>`"
    private val QUAD = Regex("(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}")

    /** Non-ASCII host code points that UTS 46 leaves as they are (golden url_parse shape rules). */
    private fun hostCharOk(c: Int): Boolean =
        c in 0xdf..0xf6 || c in 0xf8..0xff || c in 0x3b1..0x3c9 || c in 0x430..0x45f ||
            c in 0x3041..0x3096 || c in 0x30a1..0x30fa || c in 0x4e00..0x9fff || c in 0xac00..0xd7a3

    /**
     * Hand parse that follows the WHATWG URL rules for the supported shapes: scheme http or
     * https (any case), non-empty host, no userinfo, after the shared shape rules (no control
     * or DEL, no leading or trailing space, no "@" or "%" in the authority, listed non-ASCII
     * host code points only, a numeric host only as a dotted quad). Returns null when the
     * value is not one such URL (then shown as plain text).
     */
    fun parse(s: String): Parsed? {
        if (s.isEmpty() || s.any { it.code < 0x20 || it.code == 0x7f } || s.first() == ' ' || s.last() == ' ') return null
        val colon = s.indexOf(':')
        if (colon < 0) return null
        val scheme = s.substring(0, colon).lowercase()
        if (scheme != "http" && scheme != "https") return null
        if (!s.startsWith("//", colon + 1)) return null
        val start = colon + 3
        if (start < s.length && (s[start] == '/' || s[start] == '\\')) return null
        var authEnd = s.length
        for (k in start until s.length) if (s[k] == '/' || s[k] == '?' || s[k] == '#' || s[k] == '\\') { authEnd = k; break }
        val authority = s.substring(start, authEnd)
        if (authority.contains('@') || authority.contains('%')) return null
        var hostPart = authority
        var portText: String? = null
        if (authority.startsWith("[")) {
            val close = authority.indexOf(']')
            if (close < 0) return null
            val after = authority.substring(close + 1)
            if (after.isNotEmpty()) {
                if (!after.startsWith(":")) return null
                portText = after.substring(1)
            }
            hostPart = authority.substring(0, close + 1)
            val inner = hostPart.substring(1, hostPart.length - 1)
            if (inner.isEmpty() || !inner.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' || it == ':' || it == '.' }) return null
        } else {
            val c = authority.lastIndexOf(':')
            if (c >= 0) { portText = authority.substring(c + 1); hostPart = authority.substring(0, c) }
        }
        if (hostPart.isEmpty()) return null
        val host = if (hostPart.startsWith("[")) hostPart.lowercase() else asciiHost(hostPart) ?: return null
        val port = if (portText.isNullOrEmpty()) -1 else {
            val digits = portText.trimStart('0').ifEmpty { "0" }
            if (!portText.all { it in '0'..'9' } || digits.length > 5) return null
            digits.toInt().also { if (it > 65535) return null }
        }
        val portPart = when {
            port == -1 -> ""
            scheme == "http" && port == 80 -> ""
            scheme == "https" && port == 443 -> ""
            else -> ":$port"
        }
        var rest = s.substring(authEnd)
        var fragment: String? = null
        var query: String? = null
        rest.indexOf('#').let { if (it >= 0) { fragment = rest.substring(it + 1); rest = rest.substring(0, it) } }
        rest.indexOf('?').let { if (it >= 0) { query = rest.substring(it + 1); rest = rest.substring(0, it) } }
        val path = dotSegments(encode(rest.replace('\\', '/'), PATH_ENCODE)).ifEmpty { "/" }
        val href = buildString {
            append(scheme).append("://").append(host).append(portPart).append(path)
            query?.let { append('?').append(encode(it, QUERY_ENCODE)) }
            fragment?.let { append('#').append(encode(it, FRAGMENT_ENCODE)) }
        }
        return Parsed(href, host)
    }

    /**
     * ASCII-lowercase host; a label with listed non-ASCII code points becomes "xn--" punycode
     * (as UTS 46 does for them). Null on other non-ASCII, forbidden chars, or a numeric host
     * that is not a dotted quad.
     */
    private fun asciiHost(h: String): String? {
        if (h.any { it in HOST_FORBIDDEN }) return null
        val cps = h.codePoints().toArray()
        if (cps.any { it >= 0x80 && !hostCharOk(it) }) return null
        val lower = String(cps.map { if (it in 'A'.code..'Z'.code) it + 32 else it }.toIntArray(), 0, cps.size)
        val ascii = lower.split('.').joinToString(".") { l -> if (l.all { it.code < 0x80 }) l else "xn--" + punycode(l) }
        val labels = ascii.split('.').toMutableList()
        if (labels.size > 1 && labels.last().isEmpty()) labels.removeAt(labels.size - 1)
        val last = labels.last()
        val endsInNumber = (last.isNotEmpty() && last.all { it in '0'..'9' }) ||
            (last.startsWith("0x") && last.substring(2).all { it in '0'..'9' || it in 'a'..'f' })
        if (endsInNumber && !QUAD.matches(ascii)) return null
        return ascii
    }

    /** RFC 3492 punycode encoder for one label. */
    private fun punycode(label: String): String {
        val base = 36; val tMin = 1; val tMax = 26
        val cps = label.codePoints().toArray()
        val out = StringBuilder()
        for (c in cps) if (c < 0x80) out.append(c.toChar())
        val b = out.length
        var h = b
        if (b > 0) out.append('-')
        var n = 0x80; var delta = 0; var bias = 72
        fun digit(d: Int) = (if (d < 26) d + 97 else d + 22).toChar()
        fun adapt(d0: Int, num: Int, first: Boolean): Int {
            var d = if (first) d0 / 700 else d0 / 2
            d += d / num
            var k = 0
            while (d > ((base - tMin) * tMax) / 2) { d /= base - tMin; k += base }
            return k + (base - tMin + 1) * d / (d + 38)
        }
        while (h < cps.size) {
            val m = cps.filter { it >= n }.min()
            delta += (m - n) * (h + 1)
            n = m
            for (c in cps) {
                if (c < n) delta++
                if (c == n) {
                    var q = delta
                    var k = base
                    while (true) {
                        val t = if (k <= bias) tMin else if (k >= bias + tMax) tMax else k - bias
                        if (q < t) break
                        out.append(digit(t + (q - t) % (base - t)))
                        q = (q - t) / (base - t)
                        k += base
                    }
                    out.append(digit(q))
                    bias = adapt(delta, h + 1, h == b)
                    delta = 0
                    h++
                }
            }
            delta++
            n++
        }
        return out.toString()
    }

    /** Percent-encodes non-ASCII (as UTF-8) and the chars in [set]; existing escapes stay as given. */
    private fun encode(s: String, set: String): String {
        if (s.all { it.code < 0x80 && it !in set }) return s
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val v = b.toInt() and 0xff
            if (v >= 0x80 || v.toChar() in set) out.append('%').append("%02X".format(v)) else out.append(v.toChar())
        }
        return out.toString()
    }

    private fun dotSegments(path: String): String {
        if (!path.contains('.') && !path.contains("%2e", ignoreCase = true)) return path
        val out = ArrayList<String>()
        val parts = path.split('/')
        for ((i, seg) in parts.withIndex()) {
            val l = seg.lowercase()
            val last = i == parts.size - 1
            when (l) {
                ".", "%2e" -> if (last) out.add("")
                "..", ".%2e", "%2e.", "%2e%2e" -> { if (out.size > 1) out.removeAt(out.size - 1); if (last) out.add("") }
                else -> out.add(seg)
            }
        }
        return out.joinToString("/")
    }
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
