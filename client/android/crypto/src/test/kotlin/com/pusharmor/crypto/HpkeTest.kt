package com.pusharmor.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Known-answer tests from RFC 9180.
 * A.3: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode (RFC text, appendix A.3.1).
 * AES-256-GCM: the mode 0 / kem 16 / kdf 1 / aead 2 entry of test-vectors.json published with
 * RFC 9180 (github.com/cfrg/draft-irtf-cfrg-hpke), the exact production suite.
 */
class HpkeTest {
    private class Vec(
        val nk: Int, val info: String, val skEm: String, val pkEm: String, val skRm: String, val pkRm: String,
        val shared: String, val key: String, val nonce: String, val encs: List<Triple<Long, String, String>>, // seq, aad, ct
    )

    private val pt = hexToBytes("4265617574792069732074727574682c20747275746820626561757479")

    private val a3 = Vec(
        16, "4f6465206f6e2061204772656369616e2055726e",
        "4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb",
        "04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4",
        "f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2",
        "04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0",
        "c0d26aeab536609a572b07695d933b589dcf363ff9d93c93adea537aeabb8cb8",
        "868c066ef58aae6dc589b6cfdd18f97e", "4e0bc5018beba4bf004cca59",
        listOf(
            Triple(0L, "436f756e742d30", "5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434"),
            Triple(1L, "436f756e742d31", "fa6f037b47fc21826b610172ca9637e82d6e5801eb31cbd3748271affd4ecb06646e0329cbdf3c3cd655b28e82"),
            Triple(256L, "436f756e742d323536", "10f179686aa2caec1758c8e554513f16472bd0a11e2a907dde0b212cbe87d74f367f8ffe5e41cd3e9962a6afb2"),
        ),
    )

    private val aes256 = Vec(
        32, "4f6465206f6e2061204772656369616e2055726e",
        "90345e3a1d116c1dd39ae76d95ab858c142223a63e44f8f85318cfa91a84858e",
        "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
        "317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2",
        "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
        "48893fecd82f7c3456af6a42d8f56325d21e08c10fa81299986aaff54cde7b49",
        "ee16802a936d5f544771131900ee6973d0551de9e852ece2ef34bf0d5f9e1d1d", "9bc50980832a7b4b58c40161",
        listOf(
            Triple(0L, "436f756e742d30", "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f"),
            Triple(1L, "436f756e742d31", "b4e7c90d1dd62cb563694956eb517ab55d5e7d1f6366a0066c04ababaa444dbaf60a30d7bb7d3e91b969762dee"),
        ),
    )

    private fun run(v: Vec) {
        val hpke = Hpke(v.nk)
        val eph = SoftwareKeyOps.keyPairFromScalar(hexToBytes(v.skEm))
        assertEquals(v.pkEm, P256.pointOf(eph.public as java.security.interfaces.ECPublicKey).toHex())
        val (enc, ctxS) = hpke.setupBaseS(hexToBytes(v.pkRm), hexToBytes(v.info), eph)
        assertEquals(v.pkEm, enc.toHex())
        assertEquals(v.shared, ctxS.sharedSecret.toHex())
        assertEquals(v.key, ctxS.key.toHex())
        assertEquals(v.nonce, ctxS.baseNonce.toHex())
        val recipient = SoftwareKeyOps.fromPrivate(hexToBytes(v.skRm), hexToBytes(v.skRm))
        assertEquals(v.pkRm, recipient.encPub.toHex())
        val ctxR = hpke.setupBaseR(enc, recipient, hexToBytes(v.info))
        assertEquals(v.key, ctxR.key.toHex())
        for ((seq, aad, ct) in v.encs) {
            assertEquals(ct, hpke.aead(javax.crypto.Cipher.ENCRYPT_MODE, ctxS, hexToBytes(aad), pt, seq).toHex())
            assertArrayEquals(pt, hpke.aead(javax.crypto.Cipher.DECRYPT_MODE, ctxR, hexToBytes(aad), hexToBytes(ct), seq))
        }
        // single-shot seal/open (sequence 0)
        val (_, aad0, ct0) = v.encs[0]
        val sealed = hpke.seal(hexToBytes(v.pkRm), hexToBytes(v.info), hexToBytes(aad0), pt, eph)
        assertEquals(v.pkEm + ct0, sealed.toHex())
        assertArrayEquals(pt, hpke.open(sealed, recipient, hexToBytes(v.info), hexToBytes(aad0)))
    }

    @Test fun rfc9180_A3_p256_sha256_aes128gcm() = run(a3)

    @Test fun rfc9180_p256_sha256_aes256gcm() = run(aes256)

    @Test fun openRejectsTamperWrongAadWrongInfoBadEnc() {
        val r = SoftwareKeyOps.generate()
        val h = Hpke()
        val msg = h.seal(r.encPub, Hpke.INFO_MSG, ascii("aad"), ascii("hello"))
        assertArrayEquals(ascii("hello"), h.open(msg, r, Hpke.INFO_MSG, ascii("aad")))
        val t = msg.copyOf(); t[t.size - 1] = (t[t.size - 1].toInt() xor 1).toByte()
        assertThrows(CryptoException::class.java) { h.open(t, r, Hpke.INFO_MSG, ascii("aad")) }
        assertThrows(CryptoException::class.java) { h.open(msg, r, Hpke.INFO_MSG, ascii("aae")) }
        assertThrows(CryptoException::class.java) { h.open(msg, r, Hpke.INFO_NAME, ascii("aad")) }
        assertThrows(CryptoException::class.java) { h.open(msg, SoftwareKeyOps.generate(), Hpke.INFO_MSG, ascii("aad")) }
        val badEnc = msg.copyOf(); badEnc[64] = (badEnc[64].toInt() xor 1).toByte()
        assertThrows(CryptoException::class.java) { h.open(badEnc, r, Hpke.INFO_MSG, ascii("aad")) }
        assertThrows(CryptoException::class.java) { h.open(msg.copyOf(80), r, Hpke.INFO_MSG, ascii("aad")) }
    }

    @Test fun hkdfRfc5869Case1() {
        val prk = Hkdf.extract(hexToBytes("000102030405060708090a0b0c"), hexToBytes("0b".repeat(22)))
        assertEquals("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5", prk.toHex())
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            Hkdf.expand(prk, hexToBytes("f0f1f2f3f4f5f6f7f8f9"), 42).toHex(),
        )
    }

    @Test fun hkdfRfc5869Case3EmptySalt() {
        val prk = Hkdf.extract(ByteArray(0), hexToBytes("0b".repeat(22)))
        assertEquals("19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04", prk.toHex())
        assertEquals(
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
            Hkdf.expand(prk, ByteArray(0), 42).toHex(),
        )
    }
}
