package com.pusharmor.crypto

/**
 * Strict, canonical base64url (RFC 4648 URL alphabet, no padding).
 * Decoding rejects "=", any char outside A-Z a-z 0-9 - _, length mod 4 = 1 and nonzero
 * spare bits. Every wire value goes through this codec.
 */
object B64url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val REVERSE = IntArray(128) { -1 }.also { r ->
        for (i in ALPHABET.indices) r[ALPHABET[i].code] = i
    }

    fun encode(data: ByteArray): String {
        val sb = StringBuilder((data.size * 4 + 2) / 3)
        var i = 0
        while (i + 3 <= data.size) {
            val v = ((data[i].toInt() and 0xFF) shl 16) or ((data[i + 1].toInt() and 0xFF) shl 8) or
                (data[i + 2].toInt() and 0xFF)
            sb.append(ALPHABET[(v ushr 18) and 63]).append(ALPHABET[(v ushr 12) and 63])
                .append(ALPHABET[(v ushr 6) and 63]).append(ALPHABET[v and 63])
            i += 3
        }
        when (data.size - i) {
            1 -> {
                val v = (data[i].toInt() and 0xFF) shl 16
                sb.append(ALPHABET[(v ushr 18) and 63]).append(ALPHABET[(v ushr 12) and 63])
            }
            2 -> {
                val v = ((data[i].toInt() and 0xFF) shl 16) or ((data[i + 1].toInt() and 0xFF) shl 8)
                sb.append(ALPHABET[(v ushr 18) and 63]).append(ALPHABET[(v ushr 12) and 63])
                    .append(ALPHABET[(v ushr 6) and 63])
            }
        }
        return sb.toString()
    }

    /** Strict decode; returns null on any violation. */
    fun decodeOrNull(s: String): ByteArray? {
        val len = s.length
        if (len % 4 == 1) return null
        val vals = IntArray(len)
        for (i in 0 until len) {
            val c = s[i].code
            if (c >= 128) return null
            val v = REVERSE[c]
            if (v < 0) return null
            vals[i] = v
        }
        val out = ByteArray(len * 3 / 4)
        var o = 0
        var i = 0
        while (i + 4 <= len) {
            val v = (vals[i] shl 18) or (vals[i + 1] shl 12) or (vals[i + 2] shl 6) or vals[i + 3]
            out[o++] = (v ushr 16).toByte(); out[o++] = (v ushr 8).toByte(); out[o++] = v.toByte()
            i += 4
        }
        when (len - i) {
            2 -> {
                if (vals[i + 1] and 0x0F != 0) return null
                out[o++] = ((vals[i] shl 2) or (vals[i + 1] ushr 4)).toByte()
            }
            3 -> {
                if (vals[i + 2] and 0x03 != 0) return null
                val v = (vals[i] shl 12) or (vals[i + 1] shl 6) or vals[i + 2]
                out[o++] = (v ushr 10).toByte()
                out[o++] = (v ushr 2).toByte()
            }
        }
        return out
    }

    fun decode(s: String): ByteArray = decodeOrNull(s) ?: throw CryptoException("bad b64url")

    /** Strict decode that also requires an exact decoded length. */
    fun decodeExact(s: String, size: Int): ByteArray? = decodeOrNull(s)?.takeIf { it.size == size }
}

class CryptoException(message: String) : Exception(message)
