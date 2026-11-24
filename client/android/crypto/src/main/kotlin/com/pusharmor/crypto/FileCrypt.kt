package com.pusharmor.crypto

import org.bouncycastle.crypto.InvalidCipherTextException
import org.bouncycastle.crypto.engines.AESEngine
import org.bouncycastle.crypto.modes.GCMBlockCipher
import org.bouncycastle.crypto.modes.GCMModeCipher
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.security.SecureRandom

/** The input held more or fewer bytes than its stated size (the picked file changed while it was read). */
class FileChangedException : IOException("file size changed")

/**
 * File blobs: streaming AES-256-GCM through the Bouncy Castle lightweight API, one random 32-byte key and
 * 12-byte nonce per file, no AAD, one 16-byte tag, never chunked. blob = nonce (12) || ciphertext || tag (16).
 * Memory use is a small fixed buffer, whatever the file size.
 */
object FileCrypt {
    /** Largest plaintext of a file, in bytes. */
    const val MAX_FILE = 100_000_000L
    /** Blob bytes beyond the plaintext: the 12-byte nonce and the 16-byte tag. */
    const val BLOB_OVERHEAD = 28
    const val KEY_LEN = 32
    const val NONCE_LEN = 12
    private const val TAG_BITS = 128
    private const val CHUNK = 64 * 1024
    /** Heap one streaming seal or open needs; the free-memory check before a decrypt asks for this much. */
    const val WORKING_MEMORY = 16L * 1024 * 1024

    private val random = SecureRandom()

    /** A new random 32-byte file key. */
    fun newKey(): ByteArray = ByteArray(KEY_LEN).also { random.nextBytes(it) }

    private fun gcm(encrypt: Boolean, key: ByteArray, nonce: ByteArray): GCMModeCipher {
        if (key.size != KEY_LEN) throw CryptoException("bad file key")
        if (nonce.size != NONCE_LEN) throw CryptoException("bad nonce")
        return GCMBlockCipher.newInstance(AESEngine.newInstance()).also { it.init(encrypt, AEADParameters(KeyParameter(key), TAG_BITS, nonce)) }
    }

    /**
     * Seals exactly [size] bytes of [input] into [output] as one blob; returns the 43-char b64url SHA-256 of the blob.
     * Throws [FileChangedException] when [input] holds more or fewer bytes. [nonce]: tests only.
     */
    fun seal(key: ByteArray, input: InputStream, size: Long, output: OutputStream, nonce: ByteArray = ByteArray(NONCE_LEN).also { random.nextBytes(it) }): String {
        val c = gcm(true, key, nonce)
        val md = MessageDigest.getInstance("SHA-256")
        fun put(b: ByteArray, len: Int) { if (len > 0) { md.update(b, 0, len); output.write(b, 0, len) } }
        put(nonce, nonce.size)
        val buf = ByteArray(CHUNK)
        val out = ByteArray(CHUNK + 32)
        var left = size
        while (true) {
            val r = input.read(buf, 0, buf.size)
            if (r < 0) break
            left -= r
            if (left < 0) throw FileChangedException()
            put(out, c.processBytes(buf, 0, r, out, 0))
        }
        if (left != 0L) throw FileChangedException()
        put(out, c.doFinal(out, 0))
        return B64url.encode(md.digest())
    }

    /**
     * Opens a blob from [input] into [output]. false when the blob is shorter than [BLOB_OVERHEAD] or its tag
     * fails; [output] then holds unchecked bytes that the caller must delete. Write the plaintext to a temp file
     * and keep it only when this returns true.
     */
    fun open(key: ByteArray, input: InputStream, output: OutputStream): Boolean {
        val nonce = ByteArray(NONCE_LEN)
        var got = 0
        while (got < NONCE_LEN) {
            val r = input.read(nonce, got, NONCE_LEN - got)
            if (r < 0) return false
            got += r
        }
        val c = gcm(false, key, nonce)
        val buf = ByteArray(CHUNK)
        val out = ByteArray(CHUNK + 32)
        var body = 0L
        while (true) {
            val r = input.read(buf, 0, buf.size)
            if (r < 0) break
            body += r
            val n = c.processBytes(buf, 0, r, out, 0)
            if (n > 0) output.write(out, 0, n)
        }
        if (body < TAG_BITS / 8) return false
        val n = try { c.doFinal(out, 0) } catch (e: InvalidCipherTextException) { return false }
        if (n > 0) output.write(out, 0, n)
        return true
    }

    /** The 43-char b64url SHA-256 of all of [input]. */
    fun sha256(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(CHUNK)
        while (true) {
            val r = input.read(buf)
            if (r < 0) break
            md.update(buf, 0, r)
        }
        return B64url.encode(md.digest())
    }
}
