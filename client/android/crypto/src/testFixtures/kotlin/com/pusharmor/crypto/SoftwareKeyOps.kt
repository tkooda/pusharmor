package com.pusharmor.crypto

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPrivateKeySpec
import javax.crypto.KeyAgreement

/** Software KeyOps for JVM tests (the app uses Android Keystore keys). */
class SoftwareKeyOps(
    private val signPriv: PrivateKey,
    override val signPub: ByteArray,
    private val encPriv: PrivateKey,
    override val encPub: ByteArray,
) : KeyOps {
    override fun sign(data: ByteArray): ByteArray {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(signPriv)
        s.update(data)
        return P256.derToRaw(s.sign())
    }

    override fun ecdh(peerPoint: ByteArray): ByteArray {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(encPriv)
        ka.doPhase(P256.publicKey(peerPoint), true)
        return ka.generateSecret()
    }

    companion object {
        fun generate(): SoftwareKeyOps {
            val s = P256.generateSoftware()
            val e = P256.generateSoftware()
            return SoftwareKeyOps(
                s.private, P256.pointOf(s.public as ECPublicKey),
                e.private, P256.pointOf(e.public as ECPublicKey),
            )
        }

        fun fromPrivate(signScalar: ByteArray, encScalar: ByteArray): SoftwareKeyOps {
            val s = keyPairFromScalar(signScalar)
            val e = keyPairFromScalar(encScalar)
            return SoftwareKeyOps(s.private, P256.pointOf(s.public as ECPublicKey), e.private, P256.pointOf(e.public as ECPublicKey))
        }

        /** Builds a JCA key pair from a raw 32-byte private scalar (public point computed here). */
        fun keyPairFromScalar(scalar: ByteArray): KeyPair {
            val params = (P256.generateSoftware().private as ECPrivateKey).params
            val d = BigInteger(1, scalar)
            val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, params))
            val pub = P256.publicKey(EcMath.publicPoint(d))
            return KeyPair(pub, priv)
        }
    }
}

/** Minimal affine P-256 arithmetic for tests only (not constant time). */
object EcMath {
    private val P = P256.P
    private val GX = BigInteger("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296", 16)
    private val GY = BigInteger("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5", 16)

    private fun add(p1: Pair<BigInteger, BigInteger>?, p2: Pair<BigInteger, BigInteger>?): Pair<BigInteger, BigInteger>? {
        if (p1 == null) return p2
        if (p2 == null) return p1
        val (x1, y1) = p1
        val (x2, y2) = p2
        val l = if (x1 == x2) {
            if (y1.add(y2).mod(P).signum() == 0) return null
            x1.multiply(x1).multiply(BigInteger.valueOf(3)).add(P256.A).multiply(y1.shiftLeft(1).modInverse(P)).mod(P)
        } else {
            y2.subtract(y1).multiply(x2.subtract(x1).modInverse(P)).mod(P)
        }
        val x3 = l.multiply(l).subtract(x1).subtract(x2).mod(P)
        val y3 = l.multiply(x1.subtract(x3)).subtract(y1).mod(P)
        return x3 to y3
    }

    fun publicPoint(d: BigInteger): ByteArray {
        var r: Pair<BigInteger, BigInteger>? = null
        var q: Pair<BigInteger, BigInteger>? = GX to GY
        for (i in 0 until d.bitLength()) {
            if (d.testBit(i)) r = add(r, q)
            q = add(q, q)
        }
        val (x, y) = r ?: throw IllegalArgumentException("zero")
        return byteArrayOf(4) + fix(x) + fix(y)
    }

    private fun fix(b: BigInteger): ByteArray {
        val a = b.toByteArray()
        return if (a.size > 32) a.copyOfRange(a.size - 32, a.size) else ByteArray(32 - a.size) + a
    }
}

fun hexToBytes(s: String): ByteArray = ByteArray(s.length / 2) { i -> s.substring(2 * i, 2 * i + 2).toInt(16).toByte() }

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xFF) }
