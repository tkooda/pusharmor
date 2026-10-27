package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.CryptoException
import com.pusharmor.crypto.Hpke
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.KeyOps
import com.pusharmor.crypto.P256
import com.pusharmor.crypto.ascii
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.KeyPair

/** Signed name entry as carried in approve / rename and stored per owner. */
data class NameEntryClear(val nameB64: String, val n: Long, val s: String) {
    fun toJson(): String = "{\"name\":${StrictJson.quote(nameB64)},\"n\":$n,\"s\":${StrictJson.quote(s)}}"
}

/** The JSON type of an inner message (exactly one per message). */
sealed class MessageBody {
    abstract val key: String

    data class Url(val value: String) : MessageBody() { override val key = "url" }
    data class Text(val value: String) : MessageBody() { override val key = "text" }
    data class Tel(val value: String) : MessageBody() { override val key = "tel" }
    data class Approve(val entry: NameEntryClear) : MessageBody() { override val key = "approve" }
    data class Rename(val entry: NameEntryClear) : MessageBody() { override val key = "rename" }
    object Deny : MessageBody() { override val key = "deny" }
    data class Remove(val peerId: String) : MessageBody() { override val key = "remove" }
    object Delete : MessageBody() { override val key = "delete" }
    object Pause : MessageBody() { override val key = "pause" }
    object Unpause : MessageBody() { override val key = "unpause" }

    /** Control types (no History row; a seen n is a silent duplicate). */
    val isControl: Boolean get() = this !is Url && this !is Text && this !is Tel

    fun valueJson(): String = when (this) {
        is Url -> StrictJson.quote(value)
        is Text -> StrictJson.quote(value)
        is Tel -> StrictJson.quote(value)
        is Approve -> entry.toJson()
        is Rename -> entry.toJson()
        is Remove -> StrictJson.quote(peerId)
        Deny, Delete, Pause, Unpause -> "1"
    }

    companion object {
        fun content(type: ContentType, value: String): MessageBody = when (type) {
            ContentType.URL -> Url(value)
            ContentType.TEXT -> Text(value)
            ContentType.TEL -> Tel(value)
        }
    }
}

/** Keys pinned for a peer by a completed pairing, plus its pairing id. */
class PinnedKeys(val signPub: ByteArray, val encPub: ByteArray, val pairingId: ByteArray)

enum class FailReason { LENGTH, DECODE, DECRYPT, ID, NOT_PINNED, KEYS_CHANGED, SIGNATURE, PAIRING_ID, PADDING, INFLATE, JSON, TYPE }

sealed class OpenResult {
    /** Dropped, "could not read". [verifiedFrom] is set only when the signature verified and History may name the peer. */
    data class Fail(val reason: FailReason, val verifiedFrom: String? = null) : OpenResult()

    /** Signed by an id with no pin here (keys flag 0): drop and coalesced fetch. */
    data class UnknownSender(val fromId: String) : OpenResult()

    data class Ok(val fromId: String, val n: Long, val body: MessageBody, val pairingId: ByteArray) : OpenResult()
}

class MessageTooLargeException : Exception("message over the wire cap")

/** Inner message build and parse (catalog Inner message). */
object InnerMessage {
    val BUCKETS = intArrayOf(512, 1024, 2048, 3800)
    private const val HEADER = 30 + 8 + 1
    private const val SIG = 64
    private const val HPKE_OVERHEAD = 65 + 16

    /** Max raw bytes that encode to at most [chars] b64url chars. */
    fun bytesForChars(chars: Int): Int = chars * 3 / 4

    fun encodedChars(bytes: Int): Int = (bytes * 4 + 2) / 3

    fun jsonOf(n: Long, body: MessageBody): String {
        require(n in 1..MAX_COUNTER)
        return "{\"n\":$n,\"${body.key}\":${body.valueJson()}}"
    }

    /** Signed string for an inner message: "PA-MSG1\n" + recipient id + "\n" + body bytes. */
    fun signedBytes(recipientId: String, body: ByteArray): ByteArray = ascii("PA-MSG1\n$recipientId\n") + body

    /**
     * Builds the padded plaintext body (everything after sig). [keys] is the sender's
     * sign_pub || enc_pub for approve messages, else null.
     */
    fun buildBody(fromId: ByteArray, pairingId: ByteArray, n: Long, body: MessageBody, keys: ByteArray?): ByteArray {
        require((body is MessageBody.Approve) == (keys != null))
        val deflated = DeflateRaw.deflate(jsonOf(n, body).toByteArray(Charsets.UTF_8))
        return buildBodyFromDeflated(fromId, pairingId, deflated, keys, if (body is MessageBody.Approve) 1024 else 512)
    }

    /** Body with given deflated bytes, zero padded to the smallest bucket >= [minBucket]. */
    fun buildBodyFromDeflated(fromId: ByteArray, pairingId: ByteArray, deflated: ByteArray, keys: ByteArray?, minBucket: Int): ByteArray {
        require(fromId.size == Ids.ID_BYTES && pairingId.size == 8)
        if (deflated.size > 0xFFFF) throw MessageTooLargeException()
        val unpadded = HEADER + (keys?.size ?: 0) + 2 + deflated.size
        val total = paddedBodySize(unpadded, minBucket) ?: throw MessageTooLargeException()
        val out = ByteBuffer.allocate(total)
        out.put(fromId).put(pairingId)
        if (keys != null) { require(keys.size == 130); out.put(1).put(keys) } else out.put(0)
        out.putShort(deflated.size.toShort()).put(deflated)
        return out.array() // remaining bytes stay zero (the pad)
    }

    /** Smallest bucket (chars) >= [minBucket] that holds a body of [bodyLen] bytes, or null. */
    fun bucketFor(bodyLen: Int, minBucket: Int = 512): Int? =
        BUCKETS.filter { it >= minBucket }.firstOrNull { bytesForChars(it) - HPKE_OVERHEAD - SIG >= bodyLen }

    fun paddedBodySize(bodyLen: Int, minBucket: Int = 512): Int? =
        bucketFor(bodyLen, minBucket)?.let { bytesForChars(it) - HPKE_OVERHEAD - SIG }

    /** Full build: body, pad, sign, prepend sig, HPKE seal; returns the b64url message. */
    fun build(
        keys: KeyOps, fromId: ByteArray, recipientId: String, recipientEncPub: ByteArray,
        pairingId: ByteArray, n: Long, body: MessageBody, ephemeral: KeyPair? = null,
    ): String {
        val embedded = if (body is MessageBody.Approve) keys.signPub + keys.encPub else null
        val plainBody = buildBody(fromId, pairingId, n, body, embedded)
        val sig = keys.sign(signedBytes(recipientId, plainBody))
        val pt = sig + plainBody
        val hpke = Hpke()
        val sealed = if (ephemeral != null) hpke.seal(recipientEncPub, Hpke.INFO_MSG, ascii(recipientId), pt, ephemeral)
        else hpke.seal(recipientEncPub, Hpke.INFO_MSG, ascii(recipientId), pt)
        val wire = B64url.encode(sealed)
        if (wire.length > SizeCap.WIRE_CAP) throw MessageTooLargeException()
        return wire
    }

    /** Receive pipeline steps 1-5 (section 4): decrypt, id checks, verify, pairing id, padding, inflate, JSON. */
    fun open(wire: String, own: KeyOps, ownId: String, ownAccount: ByteArray, lookup: (String) -> PinnedKeys?): OpenResult {
        if (wire.length > SizeCap.WIRE_CAP) return OpenResult.Fail(FailReason.LENGTH)
        val raw = B64url.decodeOrNull(wire) ?: return OpenResult.Fail(FailReason.DECODE)
        val pt = try {
            Hpke().open(raw, own, Hpke.INFO_MSG, ascii(ownId))
        } catch (e: CryptoException) {
            return OpenResult.Fail(FailReason.DECRYPT)
        }
        if (pt.size < SIG + HEADER + 2) return OpenResult.Fail(FailReason.LENGTH)
        val sig = pt.copyOf(SIG)
        val body = pt.copyOfRange(SIG, pt.size)
        val from = body.copyOf(Ids.ID_BYTES)
        val fromId = B64url.encode(from)
        if (!Ids.hasAccount(from, ownAccount)) return OpenResult.Fail(FailReason.ID)
        val pairingId = body.copyOfRange(30, 38)
        val flag = body[38].toInt()
        val pin: PinnedKeys
        var off = HEADER
        when (flag) {
            1 -> {
                if (body.size < HEADER + 130 + 2) return OpenResult.Fail(FailReason.LENGTH)
                val sp = body.copyOfRange(HEADER, HEADER + 65)
                val ep = body.copyOfRange(HEADER + 65, HEADER + 130)
                if (!Ids.idMatchesKeys(from, ownAccount, sp, ep)) return OpenResult.Fail(FailReason.ID)
                pin = lookup(fromId) ?: return OpenResult.Fail(FailReason.NOT_PINNED)
                if (!pin.signPub.contentEquals(sp) || !pin.encPub.contentEquals(ep)) return OpenResult.Fail(FailReason.KEYS_CHANGED)
                off += 130
            }
            0 -> pin = lookup(fromId) ?: return OpenResult.UnknownSender(fromId)
            else -> return OpenResult.Fail(FailReason.TYPE)
        }
        if (!P256.verify(pin.signPub, signedBytes(ownId, body), sig)) return OpenResult.Fail(FailReason.SIGNATURE)
        if (!pin.pairingId.contentEquals(pairingId)) return OpenResult.Fail(FailReason.PAIRING_ID, fromId)
        val len = ((body[off].toInt() and 0xFF) shl 8) or (body[off + 1].toInt() and 0xFF)
        off += 2
        if (off + len > body.size) return OpenResult.Fail(FailReason.PADDING)
        for (k in off + len until body.size) if (body[k] != 0.toByte()) return OpenResult.Fail(FailReason.PADDING)
        val json = DeflateRaw.inflate(body.copyOfRange(off, off + len)) ?: return OpenResult.Fail(FailReason.INFLATE)
        val parsed = parseJson(json) ?: return OpenResult.Fail(FailReason.JSON)
        val (n, mb) = parsed
        if ((flag == 1) != (mb is MessageBody.Approve)) return OpenResult.Fail(FailReason.TYPE)
        return OpenResult.Ok(fromId, n, mb, pairingId)
    }

    fun utf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (e: CharacterCodingException) {
        null
    }

    /** {"n": counter, one type key}; anything else is null (drop). */
    fun parseJson(bytes: ByteArray): Pair<Long, MessageBody>? {
        val text = utf8(bytes) ?: return null
        val obj = StrictJson.parseOrNull(text) as? JValue.JObject ?: return null
        if (obj.fields.size != 2) return null
        val n = counterOf(obj.fields["n"]) ?: return null
        val (k, v) = obj.fields.entries.first { it.key != "n" }
        val body: MessageBody = when (k) {
            "url" -> MessageBody.Url((v as? JValue.JString)?.value ?: return null)
            "text" -> MessageBody.Text((v as? JValue.JString)?.value ?: return null)
            "tel" -> MessageBody.Tel((v as? JValue.JString)?.value ?: return null)
            "approve" -> MessageBody.Approve(nameEntryOf(v) ?: return null)
            "rename" -> MessageBody.Rename(nameEntryOf(v) ?: return null)
            "remove" -> MessageBody.Remove(((v as? JValue.JString)?.value ?: return null).takeIf { Ids.decodeId(it) != null } ?: return null)
            "deny" -> if (isOne(v)) MessageBody.Deny else return null
            "delete" -> if (isOne(v)) MessageBody.Delete else return null
            "pause" -> if (isOne(v)) MessageBody.Pause else return null
            "unpause" -> if (isOne(v)) MessageBody.Unpause else return null
            else -> return null
        }
        return n to body
    }

    private fun isOne(v: JValue) = v is JValue.JNumber && v.raw == "1"

    fun nameEntryOf(v: JValue?): NameEntryClear? {
        val o = v as? JValue.JObject ?: return null
        if (o.fields.size != 3) return null
        val name = (o.fields["name"] as? JValue.JString)?.value ?: return null
        val n = counterOf(o.fields["n"]) ?: return null
        val s = (o.fields["s"] as? JValue.JString)?.value ?: return null
        return NameEntryClear(name, n, s)
    }
}
