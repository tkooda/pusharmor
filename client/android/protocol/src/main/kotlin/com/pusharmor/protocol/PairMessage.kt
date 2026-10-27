package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.CryptoException
import com.pusharmor.crypto.Hpke
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.KeyOps
import com.pusharmor.crypto.ascii
import java.security.KeyPair

enum class PairKind(val code: Int, val wire: String) {
    COMMIT(1, "commit"), REPLY(2, "reply"), OPEN(3, "open");

    companion object {
        fun of(code: Int) = entries.firstOrNull { it.code == code }
    }
}

/**
 * Pair message (catalog Pairing): HPKE to the recipient, info PA-PAIR1, aad recipient id,
 * not signed. Plaintext 193 bytes: kind(1) || from id(30) || body(162).
 *   commit: c_N(32) || 130 zero bytes
 *   reply:  sign_pub_X || enc_pub_X || r_X
 *   open:   sign_pub_N || enc_pub_N || r_N
 */
sealed class PairMessage {
    abstract val fromId: ByteArray
    abstract val kind: PairKind

    class Commit(override val fromId: ByteArray, val cN: ByteArray) : PairMessage() {
        override val kind = PairKind.COMMIT
    }

    /** reply (keys of X, r_X) or open (keys of N, r_N). */
    class Keys(override val kind: PairKind, override val fromId: ByteArray, val signPub: ByteArray, val encPub: ByteArray, val r: ByteArray) : PairMessage()

    companion object {
        const val PLAINTEXT_SIZE = 193
        const val WIRE_CHARS = 366

        fun plaintext(m: PairMessage): ByteArray {
            val body = when (m) {
                is Commit -> { require(m.cN.size == 32); m.cN + ByteArray(130) }
                is Keys -> { require(m.signPub.size == 65 && m.encPub.size == 65 && m.r.size == 32); m.signPub + m.encPub + m.r }
            }
            require(m.fromId.size == Ids.ID_BYTES)
            return byteArrayOf(m.kind.code.toByte()) + m.fromId + body
        }

        fun seal(m: PairMessage, recipientId: String, recipientEncPub: ByteArray, ephemeral: KeyPair? = null): String {
            val pt = plaintext(m)
            val h = Hpke()
            val ct = if (ephemeral != null) h.seal(recipientEncPub, Hpke.INFO_PAIR, ascii(recipientId), pt, ephemeral)
            else h.seal(recipientEncPub, Hpke.INFO_PAIR, ascii(recipientId), pt)
            return B64url.encode(ct).also { check(it.length == WIRE_CHARS) }
        }

        /**
         * Opens and checks a pair message: size, kind, own account prefix, and for reply/open
         * keys that hash to the from id with sign_pub != enc_pub. [outerKind] is the kind the
         * caller expects when it is known (the push carries only c; null skips that check).
         * Returns null on any failure (drop, Notice rule).
         */
        fun open(wire: String, own: KeyOps, ownId: String, ownAccount: ByteArray, outerKind: PairKind? = null): PairMessage? {
            if (wire.length != WIRE_CHARS) return null
            val raw = B64url.decodeOrNull(wire) ?: return null
            val pt = try { Hpke().open(raw, own, Hpke.INFO_PAIR, ascii(ownId)) } catch (e: CryptoException) { return null }
            if (pt.size != PLAINTEXT_SIZE) return null
            val kind = PairKind.of(pt[0].toInt()) ?: return null
            if (outerKind != null && outerKind != kind) return null
            val from = pt.copyOfRange(1, 31)
            if (!Ids.hasAccount(from, ownAccount)) return null
            val body = pt.copyOfRange(31, PLAINTEXT_SIZE)
            return when (kind) {
                PairKind.COMMIT -> {
                    if (body.copyOfRange(32, 162).any { it != 0.toByte() }) return null
                    Commit(from, body.copyOf(32))
                }
                else -> {
                    val sp = body.copyOf(65)
                    val ep = body.copyOfRange(65, 130)
                    if (!Ids.idMatchesKeys(from, ownAccount, sp, ep)) return null
                    Keys(kind, from, sp, ep, body.copyOfRange(130, 162))
                }
            }
        }
    }
}

/** X on open: sha256("PA-SAS1C\n" || keys || r_N) must equal the stored c_N. */
fun PairMessage.Keys.matchesCommit(storedCN: ByteArray): Boolean =
    kind == PairKind.OPEN && Ids.commit(signPub, encPub, r).contentEquals(storedCN)
