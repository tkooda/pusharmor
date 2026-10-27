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

    private fun ok(body: String = "{\"r\":{}}", epoch: Long = clock) = MockResponse().setBody(body).setHeader("PA-Epoch-Ms", epoch.toString())

    @Test fun signsExactBodyBytesAndSyncsOffset() {
        server.enqueue(ok(epoch = clock + 5000))
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
        assertEquals(5000L, offset.offsetMs)
        server.enqueue(ok())
        client.peers()
        assertEquals((clock + 5000).toString(), server.takeRequest().getHeader("PA-Time"))
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

    @Test fun no502RetryAndPermanentErrors() {
        server.enqueue(MockResponse().setResponseCode(502).setBody("{\"error\":\"email send failed\"}"))
        val r = client.authEmail("a@b.com", "k", "register", "t")
        assertEquals("could not send the email, try again", ErrorText.of(r))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"clock skew\"}"))
        assertTrue(client.peers().isClockSkew)
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"paused\"}"))
        assertTrue(client.peers().isPaused)
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

    @Test fun messagesMissingCarriesIds() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("{\"error\":\"messages missing\",\"ids\":[\"a\",\"b\"]}"))
        val r = client.pause(emptyMap()) as ApiResult.Http
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
