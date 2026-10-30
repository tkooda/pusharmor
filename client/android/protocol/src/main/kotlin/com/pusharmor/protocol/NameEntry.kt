package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.CryptoException
import com.pusharmor.crypto.Hpke
import com.pusharmor.crypto.KeyOps
import com.pusharmor.crypto.P256
import com.pusharmor.crypto.ascii
import java.security.KeyPair

/** Name entries (catalog Name entries). */
object NameEntry {
    const val MAX_CIPHERTEXT_CHARS = 1024

    /** Name: 1..32 printable ASCII (0x20..0x7E) except the double quote. */
    fun isValidName(name: String): Boolean = name.length in 1..32 && name.all { it.code in 0x20..0x7e && it != '"' }

    /** "PA-NAME1\n" + owner id + "\n" + recipient id + "\n" + pairing id (11-char b64url) + "\n" + n + "\n" + name */
    fun signedBytes(ownerId: String, recipientId: String, pairingId: ByteArray, n: Long, nameB64: String): ByteArray =
        ascii("PA-NAME1\n$ownerId\n$recipientId\n${B64url.encode(pairingId)}\n$n\n$nameB64")

    fun buildClear(keys: KeyOps, ownerId: String, recipientId: String, pairingId: ByteArray, n: Long, name: String): NameEntryClear {
        require(isValidName(name))
        val nameB64 = B64url.encode(ascii(name))
        val s = B64url.encode(keys.sign(signedBytes(ownerId, recipientId, pairingId, n, nameB64)))
        return NameEntryClear(nameB64, n, s)
    }

    /** Ciphertext for the Worker's name column: HPKE to the recipient, info PA-NAME1, aad recipient id. */
    fun seal(entry: NameEntryClear, recipientId: String, recipientEncPub: ByteArray, ephemeral: KeyPair? = null): String {
        val pt = entry.toJson().toByteArray(Charsets.UTF_8)
        val h = Hpke()
        val ct = if (ephemeral != null) h.seal(recipientEncPub, Hpke.INFO_NAME, ascii(recipientId), pt, ephemeral)
        else h.seal(recipientEncPub, Hpke.INFO_NAME, ascii(recipientId), pt)
        return B64url.encode(ct).also { check(it.length <= MAX_CIPHERTEXT_CHARS) }
    }

    /** Opens a name entry ciphertext addressed to this device; null on any failure. */
    fun open(ciphertext: String, own: KeyOps, ownId: String): NameEntryClear? {
        if (ciphertext.length > MAX_CIPHERTEXT_CHARS) return null
        val raw = B64url.decodeOrNull(ciphertext) ?: return null
        val pt = try { Hpke().open(raw, own, Hpke.INFO_NAME, ascii(ownId)) } catch (e: CryptoException) { return null }
        val text = InnerMessage.utf8(pt) ?: return null
        return InnerMessage.nameEntryOf(StrictJson.parseOrNull(text))
    }

    /**
     * Verifies a clear entry from [ownerId] to [recipientId] with the owner's pinned sign_pub,
     * over the exact strings received. Returns the decoded name, or null.
     */
    fun verify(entry: NameEntryClear, ownerSignPub: ByteArray, ownerId: String, recipientId: String, pairingId: ByteArray): String? {
        val sig = B64url.decodeExact(entry.s, 64) ?: return null
        val nameBytes = B64url.decodeOrNull(entry.nameB64) ?: return null
        val name = String(nameBytes, Charsets.ISO_8859_1)
        if (!isValidName(name)) return null
        if (!P256.verify(ownerSignPub, signedBytes(ownerId, recipientId, pairingId, entry.n, entry.nameB64), sig)) return null
        return name
    }
}
