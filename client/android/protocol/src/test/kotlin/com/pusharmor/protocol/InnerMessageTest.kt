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
            "{\"n\":1,\"n\":1,\"text\":\"a\"}", "{\"n\":1,\"text\":\"a\",\"text\":\"b\"}", "{\"n\":1}",
            "{\"n\":1,\"text\":\"a\",\"url\":\"b\"}", "{\"n\":1,\"x\":\"a\"}", "{\"n\":1,\"deny\":2}",
            "{\"n\":\"1\",\"text\":\"a\"}", "{\"n\":1,\"text\":1}",
            "{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1,\"s\":\"y\"}}", // approve needs keys flag 1
        )) assertTrue(j, open(sendJson(j)) is OpenResult.Fail)
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
}
