package com.pusharmor.crypto

import java.security.KeyPair
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Hkdf {
    fun extract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        return mac.doFinal(ikm)
    }

    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..255 * 32)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            counter++
        }
        return out
    }
}

fun sha256(vararg parts: ByteArray): ByteArray {
    val md = MessageDigest.getInstance("SHA-256")
    for (p in parts) md.update(p)
    return md.digest()
}

fun ascii(s: String): ByteArray {
    val b = ByteArray(s.length)
    for (i in s.indices) {
        val c = s[i].code
        if (c > 127) throw CryptoException("non-ASCII")
        b[i] = c.toByte()
    }
    return b
}

/**
 * Key operations on this device's two key pairs. The app backs this with Android Keystore
 * ("pa.sign", "pa.enc"); JVM tests back it with software keys.
 */
interface KeyOps {
    /** 65-byte SEC1 point of the signing key. */
    val signPub: ByteArray

    /** 65-byte SEC1 point of the ECDH (HPKE recipient) key. */
    val encPub: ByteArray

    /** ECDSA P-256 SHA-256 over [data]; returns raw r||s (64 bytes). */
    fun sign(data: ByteArray): ByteArray

    /** ECDH with the enc key; returns the 32-byte x coordinate. [peerPoint] is a checked point. */
    fun ecdh(peerPoint: ByteArray): ByteArray
}

/**
 * RFC 9180 base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-GCM (one-shot, sequence 0).
 * Production uses AES-256-GCM (aead id 0x0002). [aeadKeySize] 16 is only for the RFC
 * appendix A.3 vector (AES-128-GCM, aead id 0x0001).
 */
class Hpke(private val aeadKeySize: Int = 32) {
    private val aeadId = when (aeadKeySize) {
        32 -> 0x0002
        16 -> 0x0001
        else -> throw IllegalArgumentException("aead")
    }
    private val kemSuiteId = ascii("KEM") + i2osp(0x0010, 2)
    private val hpkeSuiteId = ascii("HPKE") + i2osp(0x0010, 2) + i2osp(0x0001, 2) + i2osp(aeadId, 2)

    class Context(val key: ByteArray, val baseNonce: ByteArray, val sharedSecret: ByteArray)

    private fun labeledExtract(suite: ByteArray, salt: ByteArray, label: String, ikm: ByteArray) =
        Hkdf.extract(salt, ascii("HPKE-v1") + suite + ascii(label) + ikm)

    private fun labeledExpand(suite: ByteArray, prk: ByteArray, label: String, info: ByteArray, len: Int) =
        Hkdf.expand(prk, i2osp(len, 2) + ascii("HPKE-v1") + suite + ascii(label) + info, len)

    private fun extractAndExpand(dh: ByteArray, kemContext: ByteArray): ByteArray {
        val eaePrk = labeledExtract(kemSuiteId, ByteArray(0), "eae_prk", dh)
        return labeledExpand(kemSuiteId, eaePrk, "shared_secret", kemContext, 32)
    }

    /** RFC 9180 DeriveKeyPair for DHKEM(P-256): returns the 32-byte private scalar. */
    fun deriveSecretKey(ikm: ByteArray): ByteArray {
        val dkpPrk = labeledExtract(kemSuiteId, ByteArray(0), "dkp_prk", ikm)
        for (counter in 0..255) {
            val bytes = labeledExpand(kemSuiteId, dkpPrk, "candidate", byteArrayOf(counter.toByte()), 32)
            val sk = java.math.BigInteger(1, bytes)
            if (sk.signum() != 0 && sk < P256.N) return bytes
        }
        throw CryptoException("derive key pair")
    }

    fun keySchedule(sharedSecret: ByteArray, info: ByteArray): Context {
        val pskIdHash = labeledExtract(hpkeSuiteId, ByteArray(0), "psk_id_hash", ByteArray(0))
        val infoHash = labeledExtract(hpkeSuiteId, ByteArray(0), "info_hash", info)
        val ksContext = byteArrayOf(0) + pskIdHash + infoHash
        val secret = labeledExtract(hpkeSuiteId, sharedSecret, "secret", ByteArray(0))
        val key = labeledExpand(hpkeSuiteId, secret, "key", ksContext, aeadKeySize)
        val nonce = labeledExpand(hpkeSuiteId, secret, "base_nonce", ksContext, 12)
        return Context(key, nonce, sharedSecret)
    }

    /** Encap to [pkR]; [ephemeral] is injectable for known-answer tests only. */
    fun setupBaseS(pkR: ByteArray, info: ByteArray, ephemeral: KeyPair = P256.generateSoftware()): Pair<ByteArray, Context> {
        val pubKey = P256.publicKey(pkR)
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(ephemeral.private)
        ka.doPhase(pubKey, true)
        val dh = ka.generateSecret()
        if (dh.size != 32) throw CryptoException("bad dh")
        val enc = P256.pointOf(ephemeral.public as ECPublicKey)
        val shared = extractAndExpand(dh, enc + pkR)
        return enc to keySchedule(shared, info)
    }

    fun setupBaseR(enc: ByteArray, keys: KeyOps, info: ByteArray): Context {
        if (!P256.isValidPoint(enc)) throw CryptoException("bad enc")
        val dh = keys.ecdh(enc)
        if (dh.size != 32) throw CryptoException("bad dh")
        val shared = extractAndExpand(dh, enc + keys.encPub)
        return keySchedule(shared, info)
    }

    /** Single-shot seal: returns enc(65) || ct || tag. */
    fun seal(pkR: ByteArray, info: ByteArray, aad: ByteArray, pt: ByteArray, ephemeral: KeyPair = P256.generateSoftware()): ByteArray {
        val (enc, ctx) = setupBaseS(pkR, info, ephemeral)
        return enc + aead(Cipher.ENCRYPT_MODE, ctx, aad, pt)
    }

    /** Single-shot open of enc(65) || ct || tag. Throws CryptoException on any failure. */
    fun open(message: ByteArray, keys: KeyOps, info: ByteArray, aad: ByteArray): ByteArray {
        if (message.size < P256.POINT_SIZE + 16) throw CryptoException("short")
        val enc = message.copyOfRange(0, P256.POINT_SIZE)
        val ctx = setupBaseR(enc, keys, info)
        return try {
            aead(Cipher.DECRYPT_MODE, ctx, aad, message.copyOfRange(P256.POINT_SIZE, message.size))
        } catch (e: java.security.GeneralSecurityException) {
            throw CryptoException("aead")
        }
    }

    /** AEAD with nonce = base_nonce XOR seq (seq 0 in production). */
    fun aead(mode: Int, ctx: Context, aad: ByteArray, data: ByteArray, seq: Long = 0): ByteArray {
        val nonce = ctx.baseNonce.copyOf()
        for (i in 0 until 8) nonce[11 - i] = (nonce[11 - i].toInt() xor ((seq ushr (8 * i)).toInt() and 0xFF)).toByte()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(mode, SecretKeySpec(ctx.key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(data)
    }

    companion object {
        val INFO_MSG = ascii("PA-MSG1")
        val INFO_NAME = ascii("PA-NAME1")
        val INFO_PAIR = ascii("PA-PAIR1")

        fun i2osp(v: Int, len: Int): ByteArray = ByteArray(len) { i -> (v ushr (8 * (len - 1 - i))).toByte() }
    }
}
