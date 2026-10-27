package com.pusharmor.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class B64urlTest {
    @Test fun rfc4648Vectors() {
        // RFC 4648 section 10 vectors, padding removed.
        val v = listOf("" to "", "f" to "Zg", "fo" to "Zm8", "foo" to "Zm9v", "foob" to "Zm9vYg", "fooba" to "Zm9vYmE", "foobar" to "Zm9vYmFy")
        for ((plain, enc) in v) {
            assertEquals(enc, B64url.encode(ascii(plain)))
            assertArrayEquals(ascii(plain), B64url.decodeOrNull(enc))
        }
    }

    @Test fun urlAlphabet() {
        assertEquals("-_8", B64url.encode(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
        assertArrayEquals(byteArrayOf(0xfb.toByte(), 0xff.toByte()), B64url.decodeOrNull("-_8"))
    }

    @Test fun strictRejects() {
        for (bad in listOf("Zg==", "Zg=", "Z", "Zm9vY", "Zm+v", "Zm/v", "Zm9 ", "Zh", "Zm9", "Zm-", "Zm9\u00e9", "Zm\n9v")) {
            if (bad == "Zm9") continue // valid: "fo"
            assertNull(bad, B64url.decodeOrNull(bad))
        }
        // nonzero spare bits
        assertNull(B64url.decodeOrNull("Zh"))
        assertNull(B64url.decodeOrNull("Zm9"[0] + "m-"))
        // 65-byte key: 87 chars, last char must carry two zero spare bits
        val key = ByteArray(65) { 0x7f }
        val enc = B64url.encode(key)
        assertEquals(87, enc.length)
        assertArrayEquals(key, B64url.decodeExact(enc, 65))
        val last = enc.last()
        val alt = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val idx = alt.indexOf(last)
        for (d in 1..3) assertNull(B64url.decodeOrNull(enc.dropLast(1) + alt[idx or d]))
    }

    @Test fun roundTripAllLengths() {
        val r = java.util.Random(1)
        for (n in 0..100) {
            val b = ByteArray(n).also { r.nextBytes(it) }
            assertArrayEquals(b, B64url.decodeOrNull(B64url.encode(b)))
        }
    }
}
