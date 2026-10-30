package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Golden
import com.pusharmor.crypto.Hpke
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.P256
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.crypto.arr
import com.pusharmor.crypto.ascii
import com.pusharmor.crypto.b64
import com.pusharmor.crypto.bool
import com.pusharmor.crypto.long
import com.pusharmor.crypto.obj
import com.pusharmor.crypto.str
import com.pusharmor.crypto.strOrNull
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** tests/vectors/golden-v1.json sections owned by :protocol, run through the production code. */
class GoldenProtocolTest {
    private fun account(name: String) = Golden.peer(name)["account"]!!.b64()
    private fun id(name: String) = Golden.peer(name).str("id")

    private fun windowOf(w: JsonObject): ReplayWindow {
        val h = w.long("h")
        val bits = ByteArray(13)
        for (e in w.arr("seen")) {
            val k = (h - e.jsonPrimitive.long).toInt()
            bits[k / 8] = (bits[k / 8].toInt() or (1 shl (k % 8))).toByte()
        }
        return ReplayWindow.of(h, bits)
    }

    private fun seenOf(w: ReplayWindow): List<Long> = (0 until 100).map { w.h - it }.filter { it >= 1 && w.check(it) == ReplayWindow.Verdict.SEEN }

    private fun peerOfPin(pin: JsonObject?): Peer? = pin?.let {
        val ruling = it.str("ruling")
        Peer(
            id = it.str("id"), signPub = it.str("sign_pub"), encPub = it.str("enc_pub"), pairingId = it["pairing_id"]!!.b64(),
            approved = ruling == "approved", deniedByMe = ruling == "denied", approveVerified = ruling == "approved",
        )
    }

    /** Runs the receive pipeline for a message case; returns (outcome, inbound). */
    private fun runMessage(c: JsonObject): Pair<String, Inbound> {
        val recv = c.str("receiver")
        val keys = Golden.keysOf(recv)
        val peer = peerOfPin(c.obj("pin"))
        val window = c.obj("window")?.let { windowOf(it) } ?: ReplayWindow.fresh()
        val history = c.arr("history").map { it.jsonPrimitive.long }.toSet()
        val inbound = ReceivePipeline.run(
            c.str("message"), keys, id(recv), account(recv),
            peerOf = { pid -> peer?.takeIf { it.id == pid } },
            windowOf = { window },
            historyIdFor = { _, _, n -> if (n in history) n else null },
        )
        val outcome = when (inbound) {
            is Inbound.Unreadable -> "unreadable"
            is Inbound.Invalid -> "invalid"
            is Inbound.RePresent -> "represent"
            is Inbound.Duplicate -> "noop"
            is Inbound.Accepted -> if (inbound.effect is Effect.Drop) "unreadable" else "accept"
        }
        return outcome to inbound
    }

    private fun checkFullMessage(c: JsonObject, padded: Boolean) {
        val name = c.str("name")
        val recv = Golden.keysOf(c.str("receiver"))
        val recvId = id(c.str("receiver"))
        val from = Golden.peer(c.str("from"))
        val wire = c.str("message")
        // open with the receiver enc_priv and compare plaintext
        val pt = Hpke().open(B64url.decode(wire), recv, Hpke.INFO_MSG, ascii(recvId))
        assertEquals(name, c.str("plaintext"), B64url.encode(pt))
        // our seal with the given ephemeral gives the same message
        val eph = SoftwareKeyOps.keyPairFromScalar(c.obj("hpke")!!["skE"]!!.b64())
        assertEquals(name, wire, B64url.encode(Hpke().seal(recv.encPub, Hpke.INFO_MSG, ascii(recvId), pt, eph)))
        val body = pt.copyOfRange(64, pt.size)
        assertEquals(name, c.str("sig"), B64url.encode(pt.copyOf(64)))
        assertEquals(name, c.str("signed_bytes"), B64url.encode(InnerMessage.signedBytes(recvId, body)))
        assertTrue(name, P256.verify(from["sign_pub"]!!.b64(), InnerMessage.signedBytes(recvId, body), pt.copyOf(64)))
        // the body from the given deflated bytes is byte for byte the same (layout + padding)
        val type = c.obj("expect")!!.str("type")
        val keys = if (type == "approve") from["sign_pub"]!!.b64() + from["enc_pub"]!!.b64() else null
        val deflated = c["deflated"]!!.b64()
        val built = InnerMessage.buildBodyFromDeflated(from["id"]!!.b64(), c.obj("pin")!!["pairing_id"]!!.b64(), deflated, keys, if (type == "approve") 1024 else 512)
        assertArrayEquals(name, body, built)
        assertEquals(name, InnerMessage.encodedChars(64 + body.size + 81), wire.length)
        if (padded) assertEquals(name, c.long("bucket").toInt(), wire.length) else assertEquals(name, c.long("wire_chars").toInt(), wire.length)
        // inflate and compare json; our JSON writer gives the same text
        assertEquals(name, c.str("json"), String(DeflateRaw.inflate(deflated)!!, Charsets.UTF_8))
        val (n, mb) = InnerMessage.parseJson(c.str("json").toByteArray())!!
        // our writer may differ in escaping (raw UTF-8 vs \\u); it must parse back to the same value
        assertEquals(name, n to mb, InnerMessage.parseJson(InnerMessage.jsonOf(n, mb).toByteArray()))
        // full receive pipeline
        val (outcome, inbound) = runMessage(c)
        val expect = c.obj("expect")!!
        assertEquals(name, expect.str("outcome"), outcome)
        val acc = inbound as Inbound.Accepted
        assertEquals(name, expect.long("n"), acc.n)
        assertEquals(name, expect.str("type"), acc.body.key)
        val value = expect["value"]!!
        when (val e = acc.effect) {
            is Effect.Show -> assertEquals(name, value.jsonPrimitive.content, e.content.value)
            is Effect.Approve -> { assertEquals(value.jsonObject.str("name"), e.name); assertEquals(value.jsonObject.long("n"), e.nameN) }
            is Effect.Rename -> { assertEquals(value.jsonObject.str("name"), e.newName); assertEquals(value.jsonObject.long("n"), e.nameN) }
            is Effect.Remove -> assertEquals(value.jsonPrimitive.content, e.targetId)
            is Effect.SelfRemoved, is Effect.Logout, Effect.Deny -> assertEquals(name, "1", value.jsonPrimitive.content)
            is Effect.Drop -> error("drop")
        }
    }

    @Test fun messages() { for (c in Golden.cases("messages")) checkFullMessage(c, padded = false) }

    @Test fun paddedMessages() { for (c in Golden.cases("padded_messages")) checkFullMessage(c, padded = true) }

    @Test fun padding() {
        for (c in Golden.cases("padding")) {
            val ptLen = c.long("plaintext_len").toInt()
            assertEquals(c.long("unpadded_chars").toInt(), InnerMessage.encodedChars(ptLen + 81))
            val bucket = InnerMessage.bucketFor(ptLen - 64)
            assertEquals(c.toString(), (c["bucket"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.toInt(), bucket)
            val padded = InnerMessage.paddedBodySize(ptLen - 64)?.plus(64)
            assertEquals((c["padded_plaintext_len"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.toInt(), padded)
        }
    }

    @Test fun contentCap() {
        for (c in Golden.cases("content_cap")) {
            val input = c.str("input")
            assertEquals(c.long("utf8_bytes").toInt(), SizeCap.utf8Size(input))
            assertEquals(c.bool("ok"), SizeCap.utf8Size(input) <= SizeCap.MAX_CONTENT_BYTES)
            assertEquals(c.str("truncated"), SizeCap.truncateUtf8(input))
        }
    }

    @Test fun inflate() {
        for (c in Golden.cases("inflate")) {
            val out = DeflateRaw.inflate(c["deflated"]!!.b64())
            assertEquals(c.str("name"), c.bool("ok"), out != null)
            if (out != null) {
                assertEquals(c.long("inflated_len").toInt(), out.size)
                assertEquals(c.str("inflated_sha256"), B64url.encode(com.pusharmor.crypto.sha256(out)))
                c.strOrNull("inflated")?.let { assertEquals(it, B64url.encode(out)) }
            }
        }
    }

    @Test fun replayWindow() {
        val ownId = id("N")
        for (c in Golden.cases("replay_window")) {
            val w = windowOf(c.obj("state")!!)
            val n = c.long("n")
            val body = when (c.str("type")) {
                "url" -> MessageBody.Url("https://example.com/"); "text" -> MessageBody.Text("x"); "tel" -> MessageBody.Tel("5551234")
                "logout" -> MessageBody.Logout
                "approve" -> MessageBody.Approve(NameEntryClear("QQ", n, "AA"))
                else -> error(c.str("type"))
            }
            val peer = Peer(id = id("X"), approved = true)
            val hist = c.bool("history_row")
            val r = Receive.decide(OpenResult.Ok(peer.id, n, body, ByteArray(8)), peer, w, ownId) { if (hist) 1L else null }
            val (outcome, after) = when (r) {
                is Inbound.Accepted -> "accept" to r.window
                is Inbound.Invalid -> "invalid" to w
                is Inbound.RePresent -> "represent" to w
                is Inbound.Duplicate -> "noop" to w
                is Inbound.Unreadable -> "unreadable" to w
            }
            assertEquals(c.str("name"), c.str("outcome"), outcome)
            val sa = c.obj("state_after")!!
            assertEquals(c.str("name"), sa.long("h"), after.h)
            assertEquals(c.str("name"), sa.arr("seen").map { it.jsonPrimitive.long }, seenOf(after))
        }
    }

    @Test fun urlParse() {
        for (c in Golden.cases("url_parse")) {
            val p = UrlCheck.parse(c.str("input"))
            assertEquals(c.str("input"), c.bool("url"), p != null)
            if (p != null) {
                assertEquals(c.str("input"), c.str("href"), p.href)
                assertEquals(c.str("input"), c.str("host"), p.host)
            }
            // auto_open is for extensions only; Android never auto-opens.
        }
    }

    @Test fun phone() {
        for (c in Golden.cases("phone")) assertEquals(c.str("input"), c.bool("phone"), Phone.isPhone(c.str("input")))
    }

    @Test fun pairingMessages() {
        val s = Golden.section("pairing")
        val cN = s["c_N"]!!.b64()
        for (m in s.arr("pair_messages").map { it.jsonObject }) {
            val to = m.str("to")
            val keys = Golden.keysOf(to)
            val pt = Hpke().open(B64url.decode(m.str("message")), keys, Hpke.INFO_PAIR, ascii(id(to)))
            assertEquals(m.str("plaintext"), B64url.encode(pt))
            val kind = PairKind.entries.first { it.wire == m.str("kind") }
            val parsed = PairMessage.open(m.str("message"), keys, id(to), account(to), kind)
            assertNotNull(m.str("kind"), parsed)
            assertArrayEquals(pt, PairMessage.plaintext(parsed!!))
            assertEquals(366, m.str("message").length)
            val eph = SoftwareKeyOps.keyPairFromScalar(m.obj("hpke")!!["skE"]!!.b64())
            assertEquals(m.str("message"), PairMessage.seal(parsed, id(to), keys.encPub, eph))
            when (parsed) {
                is PairMessage.Commit -> assertArrayEquals(cN, parsed.cN)
                is PairMessage.Keys -> if (kind == PairKind.OPEN) assertTrue(parsed.matchesCommit(cN))
            }
        }
    }

    @Test fun nameEntries() {
        for (c in Golden.cases("name_entries")) {
            val owner = Golden.peer(c.str("owner")); val recvName = c.str("recipient")
            val pid = c["pairing_id"]!!.b64()
            val signed = NameEntry.signedBytes(owner.str("id"), id(recvName), pid, c.long("n"), c.str("name_b64"))
            assertEquals(c.str("signed_string"), String(signed, Charsets.US_ASCII))
            val opened = NameEntry.open(c.str("ciphertext"), Golden.keysOf(recvName), id(recvName))!!
            assertEquals(c.str("entry_json"), opened.toJson())
            assertEquals(c.str("name_text"), NameEntry.verify(opened, owner["sign_pub"]!!.b64(), owner.str("id"), id(recvName), pid))
            assertTrue(c.str("ciphertext").length <= NameEntry.MAX_CIPHERTEXT_CHARS)
        }
    }

    @Test fun pairDecide() {
        for (c in Golden.cases("pair_decide")) {
            val i = c.obj("input")!!
            val e = i.obj("entry")
            val entry = e?.let {
                PairEntryView(
                    role = PairRole.valueOf(it.str("role")),
                    state = PairState.valueOf(it.str("state").uppercase()),
                    cN = it.strOrNull("c_N")?.let { s -> B64url.decode(s) },
                    authorized = it.strOrNull("reply_authorized")?.toBoolean() ?: false,
                )
            }
            val approvesMe = (i["approves_me"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.toBoolean()
            val input = CommitInput(
                ownId = Ids.decodeId(i.str("own_id"))!!, fromId = Ids.decodeId(i.str("from_id"))!!,
                cN = i["commit_c_N"]!!.b64(), entry = entry, pinned = i.bool("pinned"), approved = i.bool("approved"),
                approveVerified = i.bool("approve_verified"), listApprovesMe = approvesMe, listAfterVerify = i.bool("get_after_verify"),
                listed = when (i.str("listed")) { "yes" -> Listed.YES; "after_fetch" -> Listed.AFTER_FETCH; else -> Listed.NO },
                openEntries = i.long("open_entries").toInt(), capTimestamps = i.arr("cap").map { it.jsonPrimitive.long }, now = i.long("now"),
            )
            val d = PairDecide.commit(input)
            val o = c.obj("output")!!
            val name = c.str("name")
            assertEquals(name, o.str("action"), d.action.name.lowercase())
            assertEquals(name, o.str("notice"), d.notice.name.lowercase())
            assertEquals(name, o.str("entry"), d.entry.name.lowercase())
            assertEquals(name, o.bool("cap_counted"), d.capCounted)
        }
    }

    @Test fun pairTimeout() {
        for (c in Golden.cases("pair_timeout")) {
            val i = c.obj("input")!!
            val resend = when (i.strOrNull("resend")) {
                null -> null; "offline" -> PairDecide.Resend.OFFLINE; "logged out" -> PairDecide.Resend.LOGGED_OUT
                "429" -> PairDecide.Resend.RATE_LIMITED; "5xx" -> PairDecide.Resend.SERVER_ERROR
                "200_c_verified" -> PairDecide.Resend.OK_C_VERIFIED; "200_other" -> PairDecide.Resend.OK_OTHER
                else -> error(i.str("resend"))
            }
            assertEquals(c.str("name"), c.str("output"), PairDecide.timeout(i.bool("approve_verified"), i.bool("approved"), resend).name.lowercase())
        }
    }

    @Test fun pairHint() {
        for (c in Golden.cases("pair_hint")) {
            val i = c.obj("input")!!
            val am = (i["approves_me"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.toBoolean()
            assertEquals(c.str("name"), c.strOrNull("output"), PairDecide.hint(am, i.long("committed_s"))?.name?.lowercase())
        }
    }

    @Test fun mustFail() {
        val cases = Golden.cases("must_fail")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val name = c.str("name")
            val expected = c.str("outcome")
            when (c.str("kind")) {
                "message" -> assertEquals(name, expected, runMessage(c).first)
                "pair" -> {
                    assertEquals(name, "unreadable", expected)
                    val recv = c.str("receiver")
                    val kind = PairKind.entries.first { it.wire == c.str("expected_kind") }
                    val m = PairMessage.open(c.str("message"), Golden.keysOf(recv), id(recv), account(recv), kind)
                    val stored = c.strOrNull("stored_c_N")?.let { B64url.decode(it) }
                    val accepted = m != null && (kind != PairKind.OPEN || (m is PairMessage.Keys && stored != null && m.matchesCommit(stored)))
                    assertFalse(name, accepted)
                }
                "name_entry" -> {
                    assertEquals(name, "unreadable", expected)
                    val recv = c.str("receiver")
                    val pin = c.obj("pin")!!
                    val opened = NameEntry.open(c.str("ciphertext"), Golden.keysOf(recv), id(recv))
                    val ok = opened != null && NameEntry.verify(opened, pin["sign_pub"]!!.b64(), pin.str("id"), id(recv), pin["pairing_id"]!!.b64()) != null
                    assertFalse(name, ok)
                }
                "peer_entry" -> {
                    assertEquals(name, "unreadable", expected)
                    assertFalse(name, PeerList.entryValid(c.str("id"), c.str("sign_pub"), c.str("enc_pub"), account(c.str("receiver"))))
                }
                "request" -> assertEquals(name, "unreadable", expected) // run in :crypto GoldenCryptoTest.requestSig
                else -> error("unknown must_fail kind ${c.str("kind")}")
            }
        }
    }

    @Test fun peerEntriesOfTestKeysAreValid() {
        for (n in listOf("N", "X", "O")) {
            val p = Golden.peer(n)
            assertTrue(PeerList.entryValid(p.str("id"), p.str("sign_pub"), p.str("enc_pub"), account("N")))
        }
        assertNull(null)
    }
}
