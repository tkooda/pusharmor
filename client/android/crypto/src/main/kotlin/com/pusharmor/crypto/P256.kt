package com.pusharmor.crypto

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec

/**
 * P-256 helpers: SEC1 point checks, SPKI <-> raw point, DER <-> raw r||s, software verify.
 */
object P256 {
    val P = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
    val A: BigInteger = P.subtract(BigInteger.valueOf(3))
    val B = BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
    val N = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

    const val POINT_SIZE = 65
    const val SIG_SIZE = 64

    /** Fixed 26-byte X.509 SubjectPublicKeyInfo prefix for an uncompressed P-256 point. */
    val SPKI_PREFIX: ByteArray = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200")

    /** True iff [point] is a 65-byte uncompressed point on P-256 (x, y < p; y^2 = x^3 - 3x + b). */
    fun isValidPoint(point: ByteArray): Boolean {
        if (point.size != POINT_SIZE || point[0] != 0x04.toByte()) return false
        val x = BigInteger(1, point.copyOfRange(1, 33))
        val y = BigInteger(1, point.copyOfRange(33, 65))
        if (x >= P || y >= P) return false
        val lhs = y.multiply(y).mod(P)
        val rhs = x.multiply(x).multiply(x).add(A.multiply(x)).add(B).mod(P)
        return lhs == rhs
    }

    /** Builds a JCA public key from a checked 65-byte point. */
    fun publicKey(point: ByteArray): PublicKey {
        if (!isValidPoint(point)) throw CryptoException("bad point")
        return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + point))
    }

    /** Extracts the 65-byte point from a JCA public key (91-byte SPKI, fixed prefix checked). */
    fun point(key: PublicKey): ByteArray {
        val enc = key.encoded
        if (enc.size != SPKI_PREFIX.size + POINT_SIZE ||
            !enc.copyOfRange(0, SPKI_PREFIX.size).contentEquals(SPKI_PREFIX)
        ) throw CryptoException("bad spki")
        return enc.copyOfRange(SPKI_PREFIX.size, enc.size)
    }

    /** Strict DER SEQUENCE{INTEGER r, INTEGER s} -> raw r||s (64 bytes). */
    fun derToRaw(der: ByteArray): ByteArray {
        fun fail(): Nothing = throw CryptoException("bad der signature")
        if (der.size < 8 || der[0] != 0x30.toByte()) fail()
        val seqLen = der[1].toInt() and 0xFF
        if (seqLen >= 0x80 || seqLen != der.size - 2) fail()
        var pos = 2
        val out = ByteArray(SIG_SIZE)
        for (k in 0..1) {
            if (pos + 2 > der.size || der[pos] != 0x02.toByte()) fail()
            val len = der[pos + 1].toInt() and 0xFF
            pos += 2
            if (len == 0 || len > 33 || pos + len > der.size) fail()
            val v = der.copyOfRange(pos, pos + len)
            if (v[0].toInt() and 0x80 != 0) fail() // negative
            if (len > 1 && v[0] == 0.toByte() && v[1].toInt() and 0x80 == 0) fail() // not minimal
            val mag = if (v[0] == 0.toByte() && len > 1) v.copyOfRange(1, len) else v
            if (mag.size > 32) fail()
            val bi = BigInteger(1, mag)
            if (bi.signum() == 0 || bi >= N) fail()
            System.arraycopy(mag, 0, out, k * 32 + 32 - mag.size, mag.size)
            pos += len
        }
        if (pos != der.size) fail()
        return out
    }

    /** Raw r||s -> minimal DER. Throws when r or s is 0 or >= n. */
    fun rawToDer(raw: ByteArray): ByteArray {
        if (raw.size != SIG_SIZE) throw CryptoException("bad raw signature")
        val parts = (0..1).map { k ->
            val bi = BigInteger(1, raw.copyOfRange(k * 32, k * 32 + 32))
            if (bi.signum() == 0 || bi >= N) throw CryptoException("bad raw signature")
            bi.toByteArray() // minimal two's complement, positive (leading 0x00 when needed)
        }
        val body = parts.fold(ByteArray(0)) { acc, p -> acc + byteArrayOf(0x02, p.size.toByte()) + p }
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    /** Verifies a raw r||s ECDSA-SHA256 signature with a 65-byte public point. Never throws. */
    fun verify(point: ByteArray, data: ByteArray, rawSig: ByteArray): Boolean = try {
        val der = rawToDer(rawSig)
        val v = Signature.getInstance("SHA256withECDSA")
        v.initVerify(publicKey(point))
        v.update(data)
        v.verify(der)
    } catch (e: Exception) {
        false
    }

    /** Fresh software key pair (default provider); used for HPKE ephemeral keys. */
    fun generateSoftware(): java.security.KeyPair {
        val g = KeyPairGenerator.getInstance("EC")
        g.initialize(ECGenParameterSpec("secp256r1"))
        return g.generateKeyPair()
    }

    internal fun fixed32(bi: BigInteger): ByteArray {
        val b = bi.toByteArray()
        return when {
            b.size == 32 -> b
            b.size == 33 && b[0] == 0.toByte() -> b.copyOfRange(1, 33)
            b.size < 32 -> ByteArray(32 - b.size) + b
            else -> throw CryptoException("value too large")
        }
    }

    fun pointOf(key: ECPublicKey): ByteArray =
        byteArrayOf(0x04) + fixed32(key.w.affineX) + fixed32(key.w.affineY)
}

internal fun hex(s: String): ByteArray = ByteArray(s.length / 2) { i ->
    s.substring(2 * i, 2 * i + 2).toInt(16).toByte()
}
