package com.pusharmor.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** tests/vectors/golden-v1.json sections owned by :crypto. */
class GoldenCryptoTest {
    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

    private val idSecret by lazy { Golden.section("keys").str("id_secret").let { B64url.decode(it) } }

    @Test fun keys() {
        for (name in listOf("N", "X", "O", "Z", "S")) {
            val p = Golden.peer(name)
            val k = Golden.keysOf(name)
            assertEquals(p.str("sign_pub"), B64url.encode(k.signPub))
            assertEquals(p.str("enc_pub"), B64url.encode(k.encPub))
            val account = hmac(idSecret, Ids.emailHash(Ids.normalizeEmail(p.str("email"))!!)).copyOf(9)
            assertEquals(p.str("account"), B64url.encode(account))
            val kh = Ids.keyhash(k.signPub, k.encPub)
            assertEquals(p.str("keyhash"), B64url.encode(kh))
            val id = account + kh + hmac(idSecret, account + kh).copyOf(9)
            assertEquals(p.str("id"), B64url.encode(id))
            if (name != "S") assertTrue(Ids.idMatchesKeys(id, account, k.signPub, k.encPub))
            else assertFalse(Ids.idMatchesKeys(id, account, k.signPub, k.encPub)) // sign_pub == enc_pub
        }
    }

    @Test fun emailHash() {
        for (c in Golden.cases("email_hash")) {
            val norm = Ids.normalizeEmail(c.str("input"))
            assertEquals(c.toString(), c.strOrNull("normalized"), norm)
            if (norm != null) {
                val h = Ids.emailHash(norm)
                assertEquals(c.str("email_hash"), B64url.encode(h))
                assertEquals(c.str("account"), B64url.encode(hmac(idSecret, h).copyOf(9)))
            }
        }
    }

    @Test fun idOrder() {
        for (c in Golden.cases("id_order")) {
            val a = Ids.decodeId(c.str("a"))!!
            val b = Ids.decodeId(c.str("b"))!!
            val lower = if (Ids.compareUnsigned(a, b) < 0) "a" else "b"
            assertEquals(c.str("name"), c.str("lower"), lower)
        }
    }

    @Test fun oauthNonce() {
        for (c in Golden.cases("oauth_nonce")) {
            val sp = B64url.decode(c.str("sign_pub"))
            assertEquals(c.str("k"), Ids.oauthK(sp))
            assertEquals(c.str("nonce"), Ids.oauthNonce(c.str("purpose"), sp))
        }
    }

    @Test fun myPushSha256() {
        for (c in Golden.cases("my_push_sha256")) {
            val p = c.obj("push")!!
            val fields = when (val t = p.str("type")) {
                "fcm", "apns", "apns-sandbox" -> listOf(t, p.str("token"))
                else -> listOf(t, p.str("endpoint"), p.str("p256dh"), p.str("auth"))
            }
            assertEquals(c.str("my_push_sha256"), Ids.pushSha256(fields))
        }
    }

    @Test fun b64url() {
        for (c in Golden.cases("b64url")) {
            val d = B64url.decodeOrNull(c.str("input"))
            if (c.bool("ok")) {
                assertEquals(c.str("input"), c.str("hex"), d!!.toHex())
                assertEquals(c.str("input"), B64url.encode(d))
            } else {
                assertNull(c.str("input"), d)
            }
        }
    }

    @Test fun requestSig() {
        for (c in Golden.cases("request_sig")) {
            val body = B64url.decode(c.str("body"))
            val signed = Ids.requestSigningBytes(c.str("method"), c.str("path"), c.str("pa_time"), body)
            assertEquals(c.str("name"), c.str("signed_bytes"), B64url.encode(signed))
            val sig = B64url.decodeExact(c.str("sig"), 64)!!
            assertTrue(c.str("name"), P256.verify(B64url.decode(c.str("sign_pub")), signed, sig))
            assertTrue(requestAccepted(c.str("method"), c.str("path"), c.str("pa_time"), body, c.str("sig"), c.str("sign_pub")))
        }
        for (c in Golden.cases("must_fail").filter { it.str("kind") == "request" }) {
            assertFalse(c.str("name"), requestAccepted(c.str("method"), c.str("path"), c.str("pa_time"), B64url.decode(c.str("body")), c.str("sig"), c.str("sign_pub")))
            assertEquals("unreadable", c.str("outcome"))
        }
    }

    /** What the Worker checks on PA-Sig: 13-digit PA-Time, /v1 path, raw 64-byte sig that verifies. */
    private fun requestAccepted(method: String, path: String, time: String, body: ByteArray, sig: String, signPub: String): Boolean {
        if (!Regex("^[0-9]{13}$").matches(time) || !path.startsWith("/v1/")) return false
        val raw = B64url.decodeExact(sig, 64) ?: return false
        val pub = B64url.decodeExact(signPub, 65) ?: return false
        return P256.verify(pub, Ids.requestSigningBytes(method, path, time, body), raw)
    }

    @Test fun pairingDeterministic() {
        val s = Golden.section("pairing")
        val n = Golden.peer(s.str("N")); val x = Golden.peer(s.str("X"))
        val spN = n["sign_pub"]!!.b64(); val epN = n["enc_pub"]!!.b64()
        val spX = x["sign_pub"]!!.b64(); val epX = x["enc_pub"]!!.b64()
        val rN = s["r_N"]!!.b64(); val rX = s["r_X"]!!.b64()
        assertEquals(s.str("c_N"), B64url.encode(Ids.commit(spN, epN, rN)))
        assertEquals(s.str("fingerprint"), Ids.fingerprint(spN, epN, spX, epX, rN, rX))
        assertEquals(s.str("fingerprint_hash"), B64url.encode(sha256(ascii("PA-SAS1\n"), spN, epN, spX, epX, rN, rX)))
        assertEquals(s.str("pairing_id"), B64url.encode(Ids.pairingId(rN, rX)))
        assertEquals(s.str("pk"), Ids.pairingKey(n["id"]!!.b64(), x["id"]!!.b64()))
        for (c in s.arr("fingerprint_cases").map { it as kotlinx.serialization.json.JsonObject }) {
            assertEquals(c.str("fingerprint"), Ids.crockford(c["hash"]!!.b64(), 4))
        }
    }

    @Test fun rfc9180() {
        val v = Golden.section("rfc9180")
        assertEquals(16L, v.long("kem_id")); assertEquals(1L, v.long("kdf_id")); assertEquals(2L, v.long("aead_id")); assertEquals(0L, v.long("mode"))
        val h = Hpke()
        assertEquals(v.str("skEm"), h.deriveSecretKey(hexToBytes(v.str("ikmE"))).toHex())
        assertEquals(v.str("skRm"), h.deriveSecretKey(hexToBytes(v.str("ikmR"))).toHex())
        val eph = SoftwareKeyOps.keyPairFromScalar(hexToBytes(v.str("skEm")))
        val info = hexToBytes(v.str("info"))
        val (enc, ctx) = h.setupBaseS(hexToBytes(v.str("pkRm")), info, eph)
        assertEquals(v.str("enc"), enc.toHex())
        assertEquals(v.str("shared_secret"), ctx.sharedSecret.toHex())
        assertEquals(v.str("key"), ctx.key.toHex())
        assertEquals(v.str("base_nonce"), ctx.baseNonce.toHex())
        val r = SoftwareKeyOps.fromPrivate(hexToBytes(v.str("skRm")), hexToBytes(v.str("skRm")))
        val e0 = v.arr("encryptions")[0] as kotlinx.serialization.json.JsonObject
        val sealed = h.seal(hexToBytes(v.str("pkRm")), info, hexToBytes(e0.str("aad")), hexToBytes(e0.str("pt")), eph)
        assertEquals(v.str("enc") + e0.str("ct"), sealed.toHex())
        assertEquals(e0.str("pt"), h.open(sealed, r, info, hexToBytes(e0.str("aad"))).toHex())
    }

    /** RFC 8291 (Worker and Firefox code path; Android uses the UnifiedPush library). Checked with JCA + Hkdf. */
    @Test fun rfc8291() {
        val v = Golden.section("rfc8291")
        fun b(k: String) = v[k]!!.b64()
        val asKp = SoftwareKeyOps.keyPairFromScalar(b("as_private"))
        assertEquals(v.str("as_public"), B64url.encode(P256.pointOf(asKp.public as java.security.interfaces.ECPublicKey)))
        val ecdh = KeyAgreement.getInstance("ECDH").apply { init(asKp.private); doPhase(P256.publicKey(b("ua_public")), true) }.generateSecret()
        assertEquals(v.str("ecdh_secret"), B64url.encode(ecdh))
        val prkKey = Hkdf.extract(b("auth_secret"), ecdh)
        assertEquals(v.str("prk_key"), B64url.encode(prkKey))
        val keyInfo = ascii("WebPush: info") + byteArrayOf(0) + b("ua_public") + b("as_public")
        assertEquals(v.str("key_info"), B64url.encode(keyInfo))
        val ikm = Hkdf.expand(prkKey, keyInfo, 32)
        assertEquals(v.str("ikm"), B64url.encode(ikm))
        val prk = Hkdf.extract(b("salt"), ikm)
        assertEquals(v.str("prk"), B64url.encode(prk))
        assertEquals(v.str("cek_info"), B64url.encode(ascii("Content-Encoding: aes128gcm") + byteArrayOf(0)))
        assertEquals(v.str("nonce_info"), B64url.encode(ascii("Content-Encoding: nonce") + byteArrayOf(0)))
        val cek = Hkdf.expand(prk, b("cek_info"), 16)
        val nonce = Hkdf.expand(prk, b("nonce_info"), 12)
        assertEquals(v.str("cek"), B64url.encode(cek))
        assertEquals(v.str("nonce"), B64url.encode(nonce))
        assertArrayEquals(b("plaintext") + byteArrayOf(2), b("padded_plaintext"))
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce)) }
        val ct = c.doFinal(b("padded_plaintext"))
        assertEquals(v.str("ciphertext"), B64url.encode(ct))
        val rs = v.long("record_size").toInt()
        val header = b("salt") + byteArrayOf((rs ushr 24).toByte(), (rs ushr 16).toByte(), (rs ushr 8).toByte(), rs.toByte(), 65) + b("as_public")
        assertEquals(v.str("header"), B64url.encode(header))
        assertEquals(v.str("body"), B64url.encode(header + ct))
        // decrypt with the user agent key
        val uaKp = SoftwareKeyOps.keyPairFromScalar(b("ua_private"))
        assertEquals(v.str("ua_public"), B64url.encode(P256.pointOf(uaKp.public as java.security.interfaces.ECPublicKey)))
        val ecdh2 = KeyAgreement.getInstance("ECDH").apply { init(uaKp.private); doPhase(P256.publicKey(b("as_public")), true) }.generateSecret()
        val prk2 = Hkdf.extract(b("salt"), Hkdf.expand(Hkdf.extract(b("auth_secret"), ecdh2), keyInfo, 32))
        val d = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(Hkdf.expand(prk2, b("cek_info"), 16), "AES"), GCMParameterSpec(128, Hkdf.expand(prk2, b("nonce_info"), 12))) }
        val pt = d.doFinal(ct)
        assertEquals(v.str("plaintext"), B64url.encode(pt.copyOf(pt.size - 1)))
    }
}
