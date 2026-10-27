package com.pusharmor.protocol

/**
 * Minimal strict JSON (RFC 8259) for inner messages and name entries.
 * Numbers keep their raw token so "n" can be checked as ^[1-9][0-9]*$ on the token itself.
 * Duplicate object keys are a parse error (catalog Encodings). Nesting depth is capped.
 */
sealed class JValue {
    data class JString(val value: String) : JValue()
    data class JNumber(val raw: String) : JValue()
    data class JObject(val fields: Map<String, JValue>) : JValue()
    data class JArray(val items: List<JValue>) : JValue()
    data class JBool(val value: Boolean) : JValue()
    object JNull : JValue()
}

class JsonException(msg: String) : Exception(msg)

object StrictJson {
    private const val MAX_DEPTH = 8

    fun parse(text: String): JValue {
        val p = Parser(text)
        p.ws()
        val v = p.value(0)
        p.ws()
        if (p.i != text.length) throw JsonException("trailing data")
        return v
    }

    /** Parses and returns null on any error. */
    fun parseOrNull(text: String): JValue? = try { parse(text) } catch (e: JsonException) { null }

    private class Parser(val s: String) {
        var i = 0

        fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        fun fail(m: String): Nothing = throw JsonException(m)

        fun value(depth: Int): JValue {
            if (depth > MAX_DEPTH) fail("too deep")
            if (i >= s.length) fail("eof")
            return when (s[i]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> JValue.JString(str())
                't' -> lit("true", JValue.JBool(true))
                'f' -> lit("false", JValue.JBool(false))
                'n' -> lit("null", JValue.JNull)
                else -> num()
            }
        }

        fun lit(word: String, v: JValue): JValue {
            if (!s.startsWith(word, i)) fail("bad literal")
            i += word.length
            return v
        }

        fun obj(depth: Int): JValue {
            i++ // {
            val m = LinkedHashMap<String, JValue>()
            ws()
            if (i < s.length && s[i] == '}') { i++; return JValue.JObject(m) }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail("key")
                val k = str()
                if (m.containsKey(k)) fail("duplicate key")
                ws()
                if (i >= s.length || s[i] != ':') fail("colon")
                i++
                ws()
                m[k] = value(depth + 1)
                ws()
                if (i >= s.length) fail("eof")
                when (s[i]) {
                    ',' -> i++
                    '}' -> { i++; return JValue.JObject(m) }
                    else -> fail("object")
                }
            }
        }

        fun arr(depth: Int): JValue {
            i++
            val l = ArrayList<JValue>()
            ws()
            if (i < s.length && s[i] == ']') { i++; return JValue.JArray(l) }
            while (true) {
                ws()
                l.add(value(depth + 1))
                ws()
                if (i >= s.length) fail("eof")
                when (s[i]) {
                    ',' -> i++
                    ']' -> { i++; return JValue.JArray(l) }
                    else -> fail("array")
                }
            }
        }

        fun str(): String {
            i++ // opening quote
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) fail("eof in string")
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail("eof in escape")
                        when (val e = s[i++]) {
                            '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/')
                            'b' -> sb.append('\b'); 'f' -> sb.append('\u000C'); 'n' -> sb.append('\n')
                            'r' -> sb.append('\r'); 't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("bad \\u")
                                val h = s.substring(i, i + 4)
                                if (!h.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail("bad \\u")
                                sb.append(h.toInt(16).toChar())
                                i += 4
                            }
                            else -> fail("bad escape $e")
                        }
                    }
                    c.code < 0x20 -> fail("control char in string")
                    else -> sb.append(c)
                }
            }
        }

        fun num(): JValue {
            val start = i
            if (i < s.length && s[i] == '-') i++
            if (i >= s.length) fail("number")
            if (s[i] == '0') i++ else if (s[i] in '1'..'9') { while (i < s.length && s[i] in '0'..'9') i++ } else fail("number")
            if (i < s.length && s[i] == '.') {
                i++
                if (i >= s.length || s[i] !in '0'..'9') fail("number")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || s[i] !in '0'..'9') fail("number")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            return JValue.JNumber(s.substring(start, i))
        }
    }

    /**
     * JSON string literal as JSON.stringify writes it: raw UTF-8 for non-ASCII, escapes for
     * quote, backslash, C0 controls and lone surrogates.
     */
    fun quote(v: String): String {
        val sb = StringBuilder(v.length + 2).append('"')
        var k = 0
        while (k < v.length) {
            val c = v[k]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append("\\u").append(String.format("%04x", c.code))
                c.isHighSurrogate() && k + 1 < v.length && v[k + 1].isLowSurrogate() -> { sb.append(c).append(v[k + 1]); k++ }
                c.isSurrogate() -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            k++
        }
        return sb.append('"').toString()
    }
}

/** A counter n: JSON integer token matching ^[1-9][0-9]*$ with value 1 .. 2^53 - 1, else null. */
fun counterOf(v: JValue?): Long? {
    if (v !is JValue.JNumber) return null
    val raw = v.raw
    if (raw.isEmpty() || raw.length > 16 || raw[0] !in '1'..'9' || !raw.all { it in '0'..'9' }) return null
    val n = raw.toLong()
    return if (n in 1..MAX_COUNTER) n else null
}

const val MAX_COUNTER = (1L shl 53) - 1
