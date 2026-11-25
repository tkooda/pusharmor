package com.pusharmor.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class FileCryptTest {
    @Test fun constants() {
        val c = FileVectors.section("constants")
        assertEquals(c.long("MAX_FILE"), FileCrypt.MAX_FILE)
        assertEquals(c.long("BLOB_OVERHEAD"), FileCrypt.BLOB_OVERHEAD.toLong())
    }

    @Test fun blobVectors() {
        val cases = FileVectors.cases("blob")
        assertTrue(cases.size >= 3)
        for (c in cases) {
            val key = B64url.decode(c.str("key"))
            val pt = B64url.decode(c.str("plaintext"))
            val blob = B64url.decode(c.str("blob"))
            assertEquals(c.long("size"), pt.size.toLong())
            assertEquals(c.long("blob_size"), blob.size.toLong())
            assertEquals(pt.size + FileCrypt.BLOB_OVERHEAD, blob.size)
            val out = ByteArrayOutputStream()
            val sha = FileCrypt.seal(key, ByteArrayInputStream(pt), pt.size.toLong(), out, B64url.decode(c.str("nonce")))
            assertArrayEquals(c.str("name"), blob, out.toByteArray())
            assertEquals(c.str("sha256"), sha)
            assertEquals(c.str("sha256"), FileCrypt.sha256(ByteArrayInputStream(blob)))
            val back = ByteArrayOutputStream()
            assertTrue(FileCrypt.open(key, ByteArrayInputStream(blob), back))
            assertArrayEquals(pt, back.toByteArray())
            // any flipped bit fails: the nonce, the body, and the tag
            for (i in listOf(0, 11, 12, blob.size / 2, blob.size - 17, blob.size - 1).filter { it in blob.indices }.distinct()) {
                val bad = blob.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
                assertFalse("${c.str("name")} bit $i", FileCrypt.open(key, ByteArrayInputStream(bad), ByteArrayOutputStream()))
            }
        }
    }

    @Test fun shortBlobsFail() {
        val key = ByteArray(32)
        for (n in listOf(0, 5, 12, 27)) assertFalse(FileCrypt.open(key, ByteArrayInputStream(ByteArray(n)), ByteArrayOutputStream()))
    }

    @Test fun sha256Vectors() {
        for (c in FileVectors.cases("sha256")) assertEquals(c.str("name"), c.str("sha256"), FileCrypt.sha256(ByteArrayInputStream(B64url.decode(c.str("input")))))
    }

    @Test fun sealRefusesAChangedSize() {
        val key = FileCrypt.newKey()
        for (stated in listOf(9L, 11L)) {
            try {
                FileCrypt.seal(key, ByteArrayInputStream(ByteArray(10)), stated, ByteArrayOutputStream())
                throw AssertionError("no error for $stated")
            } catch (e: FileChangedException) { }
        }
    }

    /** Streams far more than one buffer through seal and open, with odd read sizes. */
    @Test fun largeRoundTrip() {
        val r = java.util.Random(7)
        val pt = ByteArray(3 * 65536 + 1234).also { r.nextBytes(it) }
        val key = FileCrypt.newKey()
        val out = ByteArrayOutputStream()
        val sha = FileCrypt.seal(key, Trickle(pt), pt.size.toLong(), out)
        val blob = out.toByteArray()
        assertEquals(pt.size + 28, blob.size)
        assertEquals(sha, FileCrypt.sha256(ByteArrayInputStream(blob)))
        val back = ByteArrayOutputStream()
        assertTrue(FileCrypt.open(key, Trickle(blob), back))
        assertArrayEquals(pt, back.toByteArray())
    }

    /** Returns at most 777 bytes per read. */
    private class Trickle(b: ByteArray) : ByteArrayInputStream(b) {
        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, minOf(len, 777))
    }

    @Test fun fileSigVectors() {
        val cases = FileVectors.cases("file_sig")
        assertTrue(cases.size >= 4)
        for (c in cases) {
            val bytes = if (c.str("method") == "POST") Ids.fileUploadSigningBytes(c.str("pa_time"), c.long("content_length"), c.str("file_sha256"), c.str("send_id"))
            else Ids.fileDeleteSigningBytes(c.str("id"), c.str("pa_time"))
            assertEquals(c.str("signed_text"), String(bytes, Charsets.US_ASCII))
            assertArrayEquals(B64url.decode(c.str("signed_bytes")), bytes)
            val pub = B64url.decode(c.str("sign_pub"))
            assertEquals(B64url.encode(Golden.keysOf(c.str("signer")).signPub), c.str("sign_pub"))
            assertEquals(c.str("name"), c.bool("verifies"), P256.verify(pub, bytes, B64url.decode(c.str("sig"))))
            if (c.bool("verifies")) assertTrue(P256.verify(pub, bytes, Golden.keysOf(c.str("signer")).sign(bytes)))
        }
    }

    @Test fun downloadSigVectors() {
        val cases = FileVectors.cases("download_sig")
        assertTrue(cases.size >= 3)
        assertTrue(cases.any { !it.bool("verifies") })
        for (c in cases) {
            assertEquals("GET", c.str("method"))
            assertEquals(c.str("path"), java.net.URI(c.str("url")).rawPath)
            val bytes = Ids.downloadSigningBytes(c.str("path"), c.str("pa_time"))
            assertEquals(c.str("signed_text"), String(bytes, Charsets.UTF_8))
            assertArrayEquals(B64url.decode(c.str("signed_bytes")), bytes)
            val keys = Golden.keysOf(c.str("signer"))
            assertEquals(B64url.encode(keys.signPub), c.str("sign_pub"))
            assertEquals(B64url.encode(keys.encPub), c.str("enc_pub"))
            assertEquals(87, c.str("sign_pub").length)
            assertEquals(86, c.str("sig").length)
            val pub = B64url.decode(c.str("sign_pub"))
            assertEquals(c.str("name"), c.bool("verifies"), P256.verify(pub, bytes, B64url.decode(c.str("sig"))))
            if (c.bool("verifies")) assertTrue(P256.verify(pub, bytes, keys.sign(bytes)))
        }
    }
}
