package com.pusharmor.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Known-answer values below were computed independently with Python hashlib
 * (sha256 over the catalog byte strings) and are checked byte for byte.
 */
class IdsTest {
    private val signPub = hexToBytes("04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0")
    private val encPub = hexToBytes("04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4")
    private val signPubX = hexToBytes("04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c")
    private val encPubX = hexToBytes("04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0")
    private val rN = ByteArray(32) { 1 }
    private val rX = ByteArray(32) { 2 }

    @Test fun keyhashAndIdCheck() {
        val kh = Ids.keyhash(signPub, encPub)
        assertEquals(KAT_KEYHASH, kh.toHex())
        val account = ByteArray(9) { 9 }
        val id = account + kh + ByteArray(9) { 7 }
        assertTrue(Ids.idMatchesKeys(id, account, signPub, encPub))
        assertFalse(Ids.idMatchesKeys(id, ByteArray(9) { 8 }, signPub, encPub))
        assertFalse(Ids.idMatchesKeys(id, account, encPub, signPub))
        assertFalse(Ids.idMatchesKeys(id, account, signPub, signPub))
        val bad = id.copyOf(); bad[15] = (bad[15].toInt() xor 1).toByte()
        assertFalse(Ids.idMatchesKeys(bad, account, signPub, encPub))
    }

    @Test fun pairingValues() {
        assertEquals(KAT_COMMIT, Ids.commit(signPub, encPub, rN).toHex())
        assertEquals(KAT_FP, Ids.fingerprint(signPub, encPub, signPubX, encPubX, rN, rX))
        assertEquals(KAT_PAIRID, Ids.pairingId(rN, rX).toHex())
        assertEquals(KAT_PK, Ids.pairingKey(ByteArray(30) { 1 }, ByteArray(30) { 2 }))
    }

    @Test fun crockfordBits() {
        // 0b00000 00001 00010 00011 -> "0123"
        assertEquals("0123", Ids.crockford(hexToBytes("00443000"), 4))
        assertEquals("ZZZZ", Ids.crockford(hexToBytes("fffff0"), 4))
        // 0xf8 = 11111 000.. -> "Z0"
        assertEquals("Z0", Ids.crockford(hexToBytes("f800"), 2))
    }

    @Test fun idOrderUnsigned() {
        val a = ByteArray(30) { 0x10 }
        val b = a.copyOf(); b[3] = 0x80.toByte()
        assertTrue(Ids.compareUnsigned(a, b) < 0) // 0x10 < 0x80 unsigned (signed would invert)
        assertTrue(Ids.compareUnsigned(b, a) > 0)
        assertEquals(0, Ids.compareUnsigned(a, a.copyOf()))
    }

    @Test fun emailNormalization() {
        assertEquals("a.b@example.com", Ids.normalizeEmail("  A.B@Example.COM\t"))
        assertNull(Ids.normalizeEmail("\u00e9@example.com"))
        assertEquals("i@x.com", Ids.normalizeEmail("I@X.COM"))
        assertEquals(KAT_EMAIL_HASH, Ids.emailHash("a.b@example.com").toHex())
    }

    @Test fun nonceAndPushHash() {
        assertEquals(KAT_NONCE, Ids.oauthNonce("register", signPub))
        assertEquals(KAT_PUSH, Ids.pushSha256(listOf("fcm", "tok")))
    }

    @Test fun requestSigningBytes() {
        val b = Ids.requestSigningBytes("POST", "/v1/send", "1761300000000", ascii("{}"))
        assertEquals("PA-REQ1\nPOST\n/v1/send\n1761300000000\n{}", String(b, Charsets.US_ASCII))
    }

    companion object {
        const val KAT_KEYHASH = "3c77b705a04e68ca256eedb0"
        const val KAT_COMMIT = "95a8d9c2228e60210b10faecb36c4601fc786dc019a0170fdd106850651001f3"
        const val KAT_FP = "Q6BJ"
        const val KAT_PAIRID = "ee87e829a118cecd"
        const val KAT_PK = "EMmKD-jMFHzLK5Ypo9eGVA"
        const val KAT_EMAIL_HASH = "de54fc68697ac224f98d2bf16a9d888af78fe0d4b463c451f442cbdea5a81e01"
        const val KAT_NONCE = "9kMhB7ALbe2Leg39kkwF-6qUJGku2DLgVqf8WqzXfQc"
        const val KAT_PUSH = "3m1xv9wF3cuN_UY_vDzVpQ"
    }
}
