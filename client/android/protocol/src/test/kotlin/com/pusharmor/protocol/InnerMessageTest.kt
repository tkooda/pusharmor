package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Hpke
import com.pusharmor.crypto.ascii
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InnerMessageTest {
    private val a = TestPeer()
    private val b = TestPeer()
    private val pid = ByteArray(8) { 3 }
    private fun pins(vararg p: TestPeer): (String) -> PinnedKeys? = { id -> p.firstOrNull { it.id == id }?.pin(pid) }

    private fun send(n: Long, body: MessageBody, pairing: ByteArray = pid) =
        InnerMessage.build(a.keys, a.idRaw, b.id, b.keys.encPub, pairing, n, body)

    private fun open(wire: String, lookup: (String) -> PinnedKeys? = pins(a)) =
        InnerMessage.open(wire, b.keys, b.id, TestPeer.ACCOUNT, lookup)

    @Test fun roundTripEveryType() {
        val entry = NameEntry.buildClear(a.keys, a.id, b.id, pid, 7, "Phone")
        val bodies = listOf(
            MessageBody.Url("https://example.com/a"), MessageBody.Text("hi \u00e9 \ud83d\ude00"), MessageBody.Tel("+1 555-123-4567"),
            MessageBody.Approve(entry), MessageBody.Rename(entry), MessageBody.Deny, MessageBody.Remove(b.id),
            MessageBody.Delete, MessageBody.Logout, MessageBody.Login,
            MessageBody.Text("with id", MessageBody.newId()), MessageBody.Del(listOf(MessageBody.newId(), "a-b_C")),
        )
        for (body in bodies) {
            val wire = send(7, body)
            assertTrue(wire.length in InnerMessage.BUCKETS.toList())
            if (body is MessageBody.Approve) assertTrue(wire.length >= 1024)
            val r = open(wire) as OpenResult.Ok
            assertEquals(a.id, r.fromId)
            assertEquals(7L, r.n)
            assertEquals(body.key, r.body.key)
            assertEquals(body, r.body)
        }
    }

    @Test fun bucketsAndCap() {
        assertEquals(512, send(1, MessageBody.Text("x")).length)
        val rnd = java.util.Random(5)
        val sb = StringBuilder()
        while (SizeCap.utf8Size(sb.toString()) < 2040) sb.append((0x21 + rnd.nextInt(94)).toChar())
        val big = send(1, MessageBody.Text(sb.toString()))
        assertTrue(big.length == 2048 || big.length == 3800)
        // all-control-char text at the cap still fits under 3800 (measured worst case)
        val ctl = StringBuilder(); while (ctl.length < 2048) ctl.append((rnd.nextInt(31) + 1).toChar())
        assertEquals(3800, send(1, MessageBody.Text(ctl.toString())).length)
    }

    @Test fun layoutAndSignatureCoverPad() {
        val body = InnerMessage.buildBody(a.idRaw, pid, 42, MessageBody.Url("https://example.com/a"), null)
        assertEquals(512 * 3 / 4 - 81 - 64, body.size)
        assertArrayEquals(a.idRaw, body.copyOf(30))
        assertArrayEquals(pid, body.copyOfRange(30, 38))
        assertEquals(0, body[38].toInt())
        val len = ((body[39].toInt() and 0xff) shl 8) or (body[40].toInt() and 0xff)
        val json = DeflateRaw.inflate(body.copyOfRange(41, 41 + len))!!
        assertEquals("{\"n\":42,\"url\":\"https://example.com/a\"}", String(json))
        for (k in 41 + len until body.size) assertEquals(0, body[k].toInt())
    }

    @Test fun mustFailCases() {
        val ok = send(5, MessageBody.Text("hi"))
        // tampered ciphertext
        val raw = B64url.decode(ok); raw[100] = (raw[100].toInt() xor 1).toByte()
        assertEquals(FailReason.DECRYPT, (open(B64url.encode(raw)) as OpenResult.Fail).reason)
        // wrong recipient
        val c = TestPeer()
        assertEquals(FailReason.DECRYPT, (InnerMessage.open(ok, c.keys, c.id, TestPeer.ACCOUNT, pins(a)) as OpenResult.Fail).reason)
        // wrong pairing id: verified, so the peer is named
        val wp = send(5, MessageBody.Text("hi"), ByteArray(8) { 9 })
        assertEquals(OpenResult.Fail(FailReason.PAIRING_ID, a.id), open(wp))
        // unknown sender
        assertEquals(OpenResult.UnknownSender(a.id), open(ok) { null })
        // other account
        assertEquals(FailReason.ID, (InnerMessage.open(ok, b.keys, b.id, ByteArray(9), pins(a)) as OpenResult.Fail).reason)
        // signature by another key under a's id
        val forged = InnerMessage.build(c.keys, a.idRaw, b.id, b.keys.encPub, pid, 5, MessageBody.Text("hi"))
        assertEquals(FailReason.SIGNATURE, (open(forged) as OpenResult.Fail).reason)
        // bad encoding
        assertEquals(FailReason.DECODE, (open(ok.dropLast(1) + "=") as OpenResult.Fail).reason)
    }

    /** Builds a message with a hand-written JSON (for n / key vectors). */
    private fun sendJson(json: String, nonZeroPad: Boolean = false): String {
        val d = DeflateRaw.deflate(json.toByteArray())
        val total = 512 * 3 / 4 - 81 - 64
        val body = ByteArray(total)
        System.arraycopy(a.idRaw, 0, body, 0, 30); System.arraycopy(pid, 0, body, 30, 8)
        body[39] = (d.size shr 8).toByte(); body[40] = d.size.toByte(); System.arraycopy(d, 0, body, 41, d.size)
        if (nonZeroPad) body[total - 1] = 1
        val sig = a.keys.sign(InnerMessage.signedBytes(b.id, body))
        return B64url.encode(Hpke().seal(b.keys.encPub, Hpke.INFO_MSG, ascii(b.id), sig + body))
    }

    @Test fun jsonRejects() {
        assertTrue(open(sendJson("{\"n\":1,\"text\":\"a\"}")) is OpenResult.Ok)
        for (j in listOf(
            "{\"n\":1.0,\"text\":\"a\"}", "{\"n\":1e0,\"text\":\"a\"}", "{\"n\":0,\"text\":\"a\"}",
            "{\"n\":1,\"n\":1,\"text\":\"a\"}", "{\"n\":1,\"text\":\"a\",\"text\":\"b\"}",
            "{\"n\":1,\"deny\":2}",
            "{\"n\":\"1\",\"text\":\"a\"}", "{\"n\":1,\"text\":1}",
            "{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1,\"s\":\"y\"}}", // approve needs keys flag 1
        )) assertTrue(j, open(sendJson(j)) is OpenResult.Fail)
        // valid n with no known type key: verified but ignored, not a failure
        assertTrue(open(sendJson("{\"n\":1}")) is OpenResult.Ignored)
        assertTrue(open(sendJson("{\"n\":1,\"x\":\"a\"}")) is OpenResult.Ignored)
        // unknown keys are ignored; the first known type key (url before text) wins
        assertEquals(MessageBody.Url("b"), (open(sendJson("{\"n\":1,\"text\":\"a\",\"url\":\"b\",\"x\":0}")) as OpenResult.Ok).body)
        assertEquals(FailReason.PADDING, (open(sendJson("{\"n\":1,\"text\":\"a\"}", nonZeroPad = true)) as OpenResult.Fail).reason)
    }

    @Test fun inflateCap() {
        val big = ByteArray(17000) { 'a'.code.toByte() }
        assertEquals(null, DeflateRaw.inflate(DeflateRaw.deflate(big)))
        val ok = ByteArray(16384) { 'a'.code.toByte() }
        assertArrayEquals(ok, DeflateRaw.inflate(DeflateRaw.deflate(ok)))
        assertEquals(null, DeflateRaw.inflate(DeflateRaw.deflate(ok) + byteArrayOf(1, 2)))
        assertEquals(null, DeflateRaw.inflate(DeflateRaw.deflate(ok).copyOf(5)))
    }

    @Test fun messageIdIsOptionalAndOnlyAValidIdIsKept() {
        assertEquals(22, MessageBody.newId().length)
        fun parse(json: String) = InnerMessage.parseJson(json.toByteArray())?.second
        assertEquals(MessageBody.Text("x", "abc_-9"), parse("{\"n\":1,\"text\":\"x\",\"id\":\"abc_-9\"}"))
        assertEquals(MessageBody.Text("x"), parse("{\"n\":1,\"text\":\"x\"}"))
        assertEquals(MessageBody.Text("x"), parse("{\"n\":1,\"text\":\"x\",\"id\":\"a b\"}"))
        assertEquals(MessageBody.Text("x"), parse("{\"n\":1,\"text\":\"x\",\"id\":7}"))
        assertEquals(MessageBody.Text("x"), parse("{\"n\":1,\"text\":\"x\",\"id\":\"${"a".repeat(65)}\"}"))
        assertEquals(MessageBody.Del(listOf("a", "b")), parse("{\"n\":1,\"del\":[\"a\",\"b\"]}"))
        assertEquals(null, parse("{\"n\":1,\"del\":[\"a\",\"b c\"]}"))
        assertEquals(null, parse("{\"n\":1,\"del\":\"a\"}"))
        assertEquals(null, parse("{\"n\":1,\"del\":[]}"))
    }

    /** Ids that would pass the 3800-char sealed message cap go in several del messages, each under the cap. */
    @Test fun delSplitsOverTheWireCap() {
        val ids = (1..500).map { B64url.encode(ByteArray(48).also { r -> java.security.SecureRandom().nextBytes(r) }) } // 64 chars, incompressible
        val chunks = InnerMessage.delChunks(ids)
        assertTrue(chunks.size > 1)
        assertEquals(ids, chunks.flatten())
        for (c in chunks) assertTrue(send(9_007_199_254_740_991, MessageBody.Del(c)).length <= SizeCap.WIRE_CAP)
        val short = (1..500).map { MessageBody.newId() }
        for (c in InnerMessage.delChunks(short)) assertTrue(send(1, MessageBody.Del(c)).length <= SizeCap.WIRE_CAP)
        assertEquals(1, InnerMessage.delChunks(listOf("a")).size)
        assertEquals(0, InnerMessage.delChunks(emptyList()).size)
        // compressible ids stay within the receiver's inflate cap
        for (c in InnerMessage.delChunks((1..1000).map { "a".repeat(64) })) assertTrue(InnerMessage.jsonOf(1, MessageBody.Del(c)).length <= SizeCap.INFLATE_CAP)
    }

    /** A del filled to the most 22-char ids seals to at most 3800 chars; one more id does not fit and is split off. */
    @Test fun delFilledToTheMaxSealsWithinTheCapAndOneMoreSplits() {
        val ids = (1..400).map { MessageBody.newId() }
        val first = InnerMessage.delChunks(ids).first()
        assertEquals(3800, send(9_007_199_254_740_991, MessageBody.Del(first)).length)
        assertTrue(!InnerMessage.delFits(ids.take(first.size + 1)))
        try { send(9_007_199_254_740_991, MessageBody.Del(ids.take(first.size + 1))); error("fits") } catch (e: MessageTooLargeException) { }
        println("max 22-char ids per del: ${first.size}")
    }

    /** Worst-case content of [bytes] UTF-8 bytes: the least compressible shapes, including JSON escapes. */
    private fun worstCases(bytes: Int): List<String> {
        val r = java.util.Random(bytes.toLong())
        fun fill(pick: () -> String): String { val sb = StringBuilder(); while (true) { val c = pick(); if (SizeCap.utf8Size(sb.toString() + c) > bytes) return sb.toString(); sb.append(c) } }
        val ctrl = { r.nextInt(0x20).toChar().toString() }
        val two = { (0x80 + r.nextInt(0x780)).toChar().toString() }
        val three = { (0x800 + r.nextInt(0xD000 - 0x800)).toChar().toString() }
        val four = { String(Character.toChars(0x10000 + r.nextInt(0xFFFFF))) }
        val ascii = { (0x20 + r.nextInt(0x5F)).toChar().toString() }
        return listOf(
            fill(ascii), fill(ctrl), fill(two), fill(three), fill(four),
            fill { listOf(ctrl, two, three, four, ascii)[r.nextInt(5)]() },
            fill { listOf(ctrl, ascii)[r.nextInt(2)]() },
        )
    }

    /** Free bytes left in the largest padded bucket (3800 chars sealed) for a text of [bytes] with an id and the longest n; negative: does not fit. */
    private fun worstMargin(bytes: Int): Int = worstCases(bytes).minOf { v ->
        val body = MessageBody.Text(v, MessageBody.newId())
        val deflated = DeflateRaw.deflate(InnerMessage.jsonOf(9_007_199_254_740_991, body).toByteArray(Charsets.UTF_8))
        InnerMessage.bytesForChars(InnerMessage.BUCKETS.last()) - 81 - 64 - (39 + 2 + deflated.size)
    }

    /** The content max (2048 UTF-8 bytes) with an id, worst case, still seals within the largest bucket (3800 chars). */
    @Test fun maxContentWithIdSealsWithinTheCap() {
        for (b in listOf(2000, 2048, 2500)) println("content $b bytes with id: margin ${worstMargin(b)} bytes")
        assertTrue(worstMargin(SizeCap.MAX_CONTENT_BYTES) >= 0)
        for (v in worstCases(SizeCap.MAX_CONTENT_BYTES)) for (t in ContentType.entries)
            assertTrue(send(9_007_199_254_740_991, MessageBody.content(t, v, MessageBody.newId())).length <= SizeCap.WIRE_CAP)
    }
}
