package com.pusharmor.crypto

/** Peer ids, hashes and labels from the catalog (IDs, Pairing fingerprint, Auth). */
object Ids {
    const val ID_BYTES = 30
    const val ID_CHARS = 40
    const val ACCOUNT_BYTES = 9
    const val KEYHASH_BYTES = 12
    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** keyhash = sha256("PA-ID1\n" || sign_pub || enc_pub)[0..12] */
    fun keyhash(signPub: ByteArray, encPub: ByteArray): ByteArray =
        sha256(ascii("PA-ID1\n"), signPub, encPub).copyOf(KEYHASH_BYTES)

    /** Decodes a 40-char id to its 30 raw bytes, or null. */
    fun decodeId(id: String): ByteArray? =
        if (id.length != ID_CHARS) null else B64url.decodeExact(id, ID_BYTES)

    fun accountOf(id: ByteArray): ByteArray = id.copyOf(ACCOUNT_BYTES)

    /**
     * True iff [id] (30 raw bytes) carries [ownAccount] (9 bytes) and its keyhash bytes
     * 9..21 equal keyhash(signPub, encPub). Both keys must be valid points and differ.
     */
    fun idMatchesKeys(id: ByteArray, ownAccount: ByteArray, signPub: ByteArray, encPub: ByteArray): Boolean {
        if (id.size != ID_BYTES || ownAccount.size != ACCOUNT_BYTES) return false
        if (!id.copyOf(ACCOUNT_BYTES).contentEquals(ownAccount)) return false
        if (signPub.contentEquals(encPub)) return false
        if (!P256.isValidPoint(signPub) || !P256.isValidPoint(encPub)) return false
        return id.copyOfRange(ACCOUNT_BYTES, ACCOUNT_BYTES + KEYHASH_BYTES).contentEquals(keyhash(signPub, encPub))
    }

    fun hasAccount(id: ByteArray, ownAccount: ByteArray): Boolean =
        id.size == ID_BYTES && id.copyOf(ACCOUNT_BYTES).contentEquals(ownAccount)

    /** Unsigned lexicographic compare of raw ids (I232). Negative when a < b. */
    fun compareUnsigned(a: ByteArray, b: ByteArray): Int {
        val n = minOf(a.size, b.size)
        for (i in 0 until n) {
            val x = a[i].toInt() and 0xFF
            val y = b[i].toInt() and 0xFF
            if (x != y) return x - y
        }
        return a.size - b.size
    }

    /** c_N = sha256("PA-SAS1C\n" || sign_pub_N || enc_pub_N || r_N) */
    fun commit(signPubN: ByteArray, encPubN: ByteArray, rN: ByteArray): ByteArray =
        sha256(ascii("PA-SAS1C\n"), signPubN, encPubN, rN)

    /** Pairing fingerprint: first 20 bits of the PA-SAS1 hash as 4 Crockford chars. */
    fun fingerprint(
        signPubN: ByteArray, encPubN: ByteArray, signPubX: ByteArray, encPubX: ByteArray,
        rN: ByteArray, rX: ByteArray,
    ): String {
        val h = sha256(ascii("PA-SAS1\n"), signPubN, encPubN, signPubX, encPubX, rN, rX)
        return crockford(h, 4)
    }

    /** First [chars]*5 bits of [data], MSB first, as Crockford chars. */
    fun crockford(data: ByteArray, chars: Int): String {
        val sb = StringBuilder()
        for (k in 0 until chars) {
            var v = 0
            for (b in 0 until 5) {
                val bit = k * 5 + b
                val byte = data[bit / 8].toInt() and 0xFF
                v = (v shl 1) or ((byte ushr (7 - bit % 8)) and 1)
            }
            sb.append(CROCKFORD[v])
        }
        return sb.toString()
    }

    /** Pairing id = sha256("PA-PAIRID1\n" || r_N || r_X)[0..8] */
    fun pairingId(rN: ByteArray, rX: ByteArray): ByteArray = sha256(ascii("PA-PAIRID1\n"), rN, rX).copyOf(8)

    /** Pairing key pk = b64url(sha256("PA-PAIRKEY1\n" || N id || X id)[0..16]); raw ids. */
    fun pairingKey(nId: ByteArray, xId: ByteArray): String =
        B64url.encode(sha256(ascii("PA-PAIRKEY1\n"), nId, xId).copyOf(16))

    /**
     * Email normalization (as the Worker does): trim ASCII whitespace (TAB LF VT FF CR SPACE)
     * only, then null (400 "bad email") when any char is outside ASCII, then ASCII lowercase.
     */
    fun normalizeEmail(email: String): String? {
        val t = email.trim { it == ' ' || it in '\u0009'..'\u000d' }
        if (t.any { it.code > 127 }) return null
        val sb = StringBuilder(t.length)
        for (c in t) sb.append(if (c in 'A'..'Z') (c + 32) else c)
        return sb.toString()
    }

    /** email_hash = sha256("PA-ACCT1\n" || normalized email) */
    fun emailHash(normalized: String): ByteArray = sha256(ascii("PA-ACCT1\n"), ascii(normalized))

    /** OAuth nonce = b64url(sha256("PA-NONCE1\n" + purpose + "\n" + k)), k = b64url(sha256(sign_pub)). */
    fun oauthK(signPub: ByteArray): String = B64url.encode(sha256(signPub))

    fun oauthNonce(purpose: String, signPub: ByteArray): String =
        B64url.encode(sha256(ascii("PA-NONCE1\n$purpose\n${oauthK(signPub)}")))

    /** my_push_sha256 over "type\ntoken" or "type\nendpoint\np256dh\nauth" (UTF-8). */
    fun pushSha256(fields: List<String>): String =
        B64url.encode(sha256(fields.joinToString("\n").toByteArray(Charsets.UTF_8)).copyOf(16))

    /** PA-Sig signed bytes: "PA-REQ1\n" + METHOD + "\n" + path + "\n" + PA-Time + "\n" + body. */
    fun requestSigningBytes(method: String, path: String, paTime: String, body: ByteArray): ByteArray =
        ascii("PA-REQ1\n$method\n$path\n$paTime\n") + body
}
