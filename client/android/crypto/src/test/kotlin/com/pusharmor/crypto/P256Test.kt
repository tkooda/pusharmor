package com.pusharmor.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

class P256Test {
    // RFC 9180 A.3 pkRm: a known-valid point.
    private val good = hexToBytes("04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0")

    @Test fun pointChecks() {
        assertTrue(P256.isValidPoint(good))
        assertFalse(P256.isValidPoint(good.copyOf(64)))
        assertFalse(P256.isValidPoint(byteArrayOf(2) + good.copyOfRange(1, 33)))
        val off = good.copyOf(); off[64] = (off[64].toInt() xor 1).toByte()
        assertFalse(P256.isValidPoint(off))
        val prefix = good.copyOf(); prefix[0] = 3
        assertFalse(P256.isValidPoint(prefix))
        // x >= p
        val big = byteArrayOf(4) + ByteArray(32) { 0xff.toByte() } + good.copyOfRange(33, 65)
        assertFalse(P256.isValidPoint(big))
        assertThrows(CryptoException::class.java) { P256.publicKey(off) }
    }

    @Test fun spkiRoundTrip() {
        val k = P256.publicKey(good)
        assertEquals(91, k.encoded.size)
        assertArrayEquals(good, P256.point(k))
    }

    @Test fun derKnownAnswers() {
        // r has the high bit set (needs a 0x00 sign byte), s is short (needs left padding).
        val r = "80" + "11".repeat(31)
        val s = "00".repeat(31) + "05"
        val der = hexToBytes("3026" + "0221" + "00" + r + "0201" + "05")
        assertEquals(r + s, P256.derToRaw(der).toHex())
        assertArrayEquals(der, P256.rawToDer(hexToBytes(r + s)))
    }

    @Test fun derStrictRejects() {
        val ok = "3006020101020101"
        P256.derToRaw(hexToBytes(ok))
        val bad = listOf(
            "3106020101020101", // wrong tag
            "3007020101020101", // wrong length
            "300702010102010100", // trailing byte
            "30070202000102010101".take(18), // non-minimal
            "300702020001020101", // non-minimal integer 0x0001
            "3006020181020101", // negative r
            "3006020100020101", // r = 0
            "3006020101020100", // s = 0
            "3006030101020101", // not INTEGER
            "30060201010201", // truncated
            "3026022200" + "ff".repeat(32) + "020101", // 34-byte integer
        )
        for (b in bad) assertThrows(b, CryptoException::class.java) { P256.derToRaw(hexToBytes(b)) }
        // r >= n
        val n = P256.N.toByteArray().let { if (it.size == 33) it.copyOfRange(1, 33) else it }.toHex()
        assertThrows(CryptoException::class.java) { P256.derToRaw(hexToBytes("3026022100${n}020101")) }
        assertThrows(CryptoException::class.java) { P256.rawToDer(hexToBytes(n + "00".repeat(31) + "01")) }
        assertThrows(CryptoException::class.java) { P256.rawToDer(ByteArray(64)) }
    }

    @Test fun derFuzzRoundTrip() {
        val rnd = java.util.Random(7)
        repeat(2000) {
            val raw = ByteArray(64)
            rnd.nextBytes(raw)
            // force leading zero bytes and high bits in some cases
            when (it % 4) {
                1 -> { raw[0] = 0; raw[1] = 0 }
                2 -> raw[32] = 0x80.toByte()
                3 -> for (i in 0 until 31) raw[32 + i] = 0
            }
            val r = BigInteger(1, raw.copyOf(32)); val s = BigInteger(1, raw.copyOfRange(32, 64))
            if (r.signum() == 0 || s.signum() == 0 || r >= P256.N || s >= P256.N) return@repeat
            val der = P256.rawToDer(raw)
            assertArrayEquals(raw, P256.derToRaw(der))
            // random single-byte mutations of the DER must never crash with anything but CryptoException
            val m = der.copyOf(); m[rnd.nextInt(m.size)] = rnd.nextInt(256).toByte()
            try { P256.derToRaw(m) } catch (e: CryptoException) { }
        }
    }

    @Test fun signVerifyRaw() {
        val k = SoftwareKeyOps.generate()
        val sig = k.sign(ascii("data"))
        assertEquals(64, sig.size)
        assertTrue(P256.verify(k.signPub, ascii("data"), sig))
        assertFalse(P256.verify(k.signPub, ascii("datb"), sig))
        assertFalse(P256.verify(k.encPub, ascii("data"), sig))
        assertFalse(P256.verify(k.signPub, ascii("data"), ByteArray(64)))
        assertFalse(P256.verify(k.signPub, ascii("data"), sig.copyOf(63)))
    }
}
