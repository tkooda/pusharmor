package com.pusharmor.net

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.P256
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.protocol.engine.ApiResult
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkerClientTest {
    private val server = MockWebServer().apply { start() }
    private val keys = SoftwareKeyOps.generate()
    private val id = B64url.encode(ByteArray(30) { 1 })
    private var clock = 1_761_300_000_000L
    private val slept = ArrayList<Long>()
    private val offset = MemoryClockOffset()
    private val client = WorkerClient({ keys }, { id }, offset, server.url("/"), WorkerClient.defaultHttp(), { clock }, { slept.add(it); clock += it })

    @After fun stop() = server.shutdown()

    /** [epoch] in unix seconds, as the Worker sends PA-Epoch (Q331). */
    private fun ok(body: String = "{\"r\":{}}", epoch: Long = clock / 1000) = MockResponse().setBody(body).setHeader("PA-Epoch", epoch.toString())

    @Test fun signsExactBodyBytesAndSyncsOffset() {
        server.enqueue(ok(epoch = clock / 1000 + 5))
        val r = client.send(mapOf("x" to "M"))
        assertTrue(r is ApiResult.Ok)
        val req = server.takeRequest()
        assertEquals("/v1/send", req.path)
        assertEquals(id, req.getHeader("PA-ID"))
        val t = req.getHeader("PA-Time")!!
        assertEquals(13, t.length)
        val body = req.body.readByteArray()
        assertEquals("{\"v\":1,\"m\":{\"x\":\"M\"}}", String(body))
        val sig = B64url.decode(req.getHeader("PA-Sig")!!)
        assertTrue(P256.verify(keys.signPub, Ids.requestSigningBytes("POST", "/v1/send", t, body), sig))
        assertEquals(5L, offset.offsetS)
        assertEquals("android/0.0.0", req.getHeader("PA-Client"))
        server.enqueue(ok())
        client.peers()
        assertEquals((clock + 5000).toString(), server.takeRequest().getHeader("PA-Time"))
    }

    @Test fun clockSkewReplyResyncsOffsetInSecondsAndOldHeaderIsIgnored() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"clock skew\"}").setHeader("PA-Epoch", (clock / 1000 - 600).toString()))
        assertTrue(client.peers().isClockSkew)
        assertEquals(-600L, offset.offsetS)
        server.enqueue(MockResponse().setBody("{}").setHeader("PA-Epoch-Ms", (clock + 9000).toString()))
        client.peers()
        assertEquals(-600L, offset.offsetS)
        server.takeRequest()
        assertEquals((clock - 600_000).toString(), server.takeRequest().getHeader("PA-Time"))
    }

    @Test fun paClientOnEveryRequestAnd426Text() {
        val c = WorkerClient({ keys }, { id }, offset, server.url("/"), WorkerClient.defaultHttp(), { clock }, { clock += it }, paClient = "android/0.0.19")
        server.enqueue(ok("{\"request_token\":\"rt\"}"))
        c.authEmail("a@b.com", "k", "register", "t")
        assertEquals("android/0.0.19", server.takeRequest().getHeader("PA-Client"))
        server.enqueue(MockResponse().setResponseCode(426).setBody("{\"error\":\"update required\"}"))
        val r = c.peers()
        assertEquals("android/0.0.19", server.takeRequest().getHeader("PA-Client"))
        assertEquals("Update PushArmor to continue", ErrorText.of(r))
        assertEquals(2, server.requestCount)
    }

    @Test fun http426CallsUpdateHookOnSignedAndUnsignedCalls() {
        var n = 0
        val c = WorkerClient({ keys }, { id }, offset, server.url("/"), WorkerClient.defaultHttp(), { clock }, { clock += it }, onUpdateRequired = { n++ })
        server.enqueue(ok("{\"request_token\":\"rt\"}"))
        c.authEmail("a@b.com", "k", "register", "t")
        assertEquals(0, n)
        server.enqueue(MockResponse().setResponseCode(426).setBody("{\"error\":\"update required\"}"))
        server.enqueue(MockResponse().setResponseCode(426))
        c.peers(); c.authEmail("a@b.com", "k", "register", "t")
        assertEquals(2, n)
        assertEquals(3, server.requestCount)
    }

    @Test fun authStateHookSeesUnknownPeerAndLoggedOutOnSignedCalls() {
        val seen = ArrayList<String>()
        val c = WorkerClient({ keys }, { id }, offset, server.url("/"), WorkerClient.defaultHttp(), { clock }, { clock += it }, { seen.add(it) })
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"unknown peer\"}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"logged out\"}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"clock skew\"}"))
        c.send(mapOf("x" to "M")); c.peers(); c.send(mapOf("x" to "M"))
        assertEquals(listOf("unknown peer", "logged out"), seen)
    }

    @Test fun retries429WithinBudgetWithSameBytesAndSignature() {
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "2").setBody("{\"error\":\"rate limited\",\"retry_after\":2}"))
        server.enqueue(ok())
        assertTrue(client.send(mapOf("x" to "M")) is ApiResult.Ok)
        val a = server.takeRequest(); val b = server.takeRequest()
        assertEquals(a.getHeader("PA-Sig"), b.getHeader("PA-Sig"))
        assertArrayEquals(a.body.readByteArray(), b.body.readByteArray())
        assertEquals(listOf(2000L), slept)
    }

    @Test fun retryAfterOverBudgetIsNotRetried() {
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "60").setBody("{\"error\":\"rate limited\",\"retry_after\":60}"))
        val r = client.send(mapOf("x" to "M")) as ApiResult.Http
        assertEquals(429, r.status); assertEquals(60L, r.retryAfter)
        assertEquals(1, server.requestCount)
    }

    @Test fun backoffOn503ThenGiveUpAfterThreeRetries() {
        repeat(4) { server.enqueue(MockResponse().setResponseCode(503).setBody("{\"error\":\"unavailable\"}")) }
        val r = client.peers() as ApiResult.Http
        assertEquals(503, r.status)
        assertEquals(listOf(500L, 1500L, 3000L), slept)
        assertEquals(4, server.requestCount)
    }

    @Test fun errorTextSentencesEndWithAPeriod() {
        val cases = listOf(401 to "clock skew", 401 to "logged out", 401 to "ticket expired", 401 to "unknown peer", 400 to "bad email",
            400 to "push endpoint not allowed", 413 to null, 429 to null, 502 to null, 403 to "banned", 409 to "some code", 500 to null)
        for ((status, error) in cases) {
            val t = ErrorText.of(ApiResult.Http(status, error))
            assertTrue(t, t.endsWith(".") && t[0].isUpperCase() && !t.contains("browser") && !t.contains("code") && !t.contains("Error:"))
        }
        assertEquals("No connection. Try again.", ErrorText.of(ApiResult.Network))
    }

    @Test fun no502RetryAndPermanentErrors() {
        server.enqueue(MockResponse().setResponseCode(502).setBody("{\"error\":\"email send failed\"}"))
        val r = client.authEmail("a@b.com", "k", "register", "t")
        assertEquals("Could not send the email. Try again.", ErrorText.of(r))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"clock skew\"}"))
        assertTrue(client.peers().isClockSkew)
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"logged out\"}"))
        assertTrue(client.peers().isLoggedOut)
        assertEquals(3, server.requestCount)
        assertTrue(slept.isEmpty())
    }

    @Test fun unsignedAuthAndRegisterWithoutPaId() {
        server.enqueue(ok("{\"request_token\":\"rt\"}"))
        assertEquals("rt", (client.authEmail("a@b.com", "k", "register", "t") as ApiResult.Ok).value)
        val a = server.takeRequest()
        assertNull(a.getHeader("PA-Sig")); assertNull(a.getHeader("PA-ID"))
        server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":\"peer limit\",\"ticket\":\"t2\",\"peers\":[]}"))
        val r = client.register("t", "s", "e")
        assertTrue(r is WorkerClient.RegisterResult.Limit)
        val reg = server.takeRequest()
        assertNull(reg.getHeader("PA-ID"))
        assertTrue(reg.getHeader("PA-Sig") != null)
        assertTrue(String(reg.body.readByteArray()).contains("\"push\":null"))
    }

    @Test fun peersParsesCliPlatformAndListening() {
        fun e(id: String, platform: String, extra: String) =
            "{\"id\":\"$id\",\"sign_pub\":\"s\",\"enc_pub\":\"e\",\"platform\":\"$platform\",\"created\":1$extra}"
        server.enqueue(ok("{\"peers\":[" + e("a", "cli", ",\"listening\":false") + "," + e("b", "cli", ",\"listening\":true") + "," + e("c", "android", "") + "]}"))
        val ps = (client.peers() as ApiResult.Ok).value.peers
        assertEquals(listOf("cli", "cli", "android"), ps.map { it.platform })
        assertEquals(listOf(false, true, true), ps.map { it.listening })
    }

    @Test fun messagesMissingCarriesIds() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("{\"error\":\"messages missing\",\"ids\":[\"a\",\"b\"]}"))
        val r = client.logout(emptyMap()) as ApiResult.Http
        assertTrue(r.isMessagesMissing)
        assertEquals(listOf("a", "b"), r.ids)
    }

    @Test fun networkErrorRetriedThenReported() {
        server.shutdown()
        assertTrue(client.peers() is ApiResult.Network)
    }

    @Test fun oversizedBodyIsNetworkAndNotRetried() {
        val big = okio.Buffer().apply { write(ByteArray(1 shl 20) { 'a'.code.toByte() }); repeat(49) { write(ByteArray(1 shl 20)) } } // 50 MB
        server.enqueue(MockResponse().setBody(big))
        assertTrue(client.send(emptyMap()) is ApiResult.Network)
        assertEquals(1, server.requestCount)
    }

    @Test fun peersOnceIsOneShortAttempt() {
        server.enqueue(ok("{\"peers\":[]}").setHeadersDelay(8, java.util.concurrent.TimeUnit.SECONDS))
        val t = System.nanoTime()
        assertTrue(client.peersOnce() is ApiResult.Network)
        assertTrue((System.nanoTime() - t) / 1_000_000 < WorkerClient.ONCE_TIMEOUT_MS + 1_000)
        assertEquals(1, server.requestCount)
        assertTrue(slept.isEmpty())
    }
}
