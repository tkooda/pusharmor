package com.pusharmor.net

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.FileCrypt
import com.pusharmor.crypto.FileVectors
import com.pusharmor.crypto.Golden
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.P256
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.crypto.str
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

class FileClientTest {
    private class Offset(override var offsetS: Long = 0) : ClockOffset

    private val server = MockWebServer().apply { start() }
    private val keys = SoftwareKeyOps.generate()
    private val id = B64url.encode(ByteArray(30) { 1 })
    private var clock = 1_795_319_232_123L
    private val slept = ArrayList<Long>()
    private val offset = Offset()
    private val dir: File = Files.createTempDirectory("pa-file").toFile()

    /** Every file host request goes to the mock server, path kept. */
    private val http = FileClient.defaultHttp().newBuilder().addInterceptor(Interceptor { chain ->
        val u = chain.request().url
        chain.proceed(chain.request().newBuilder().url(server.url(u.encodedPath)).build())
    }).build()
    private val client = FileClient({ keys }, { id }, offset, server.url("/"), http, { clock }, { slept.add(it); clock += it })

    @After fun stop() { server.shutdown(); dir.deleteRecursively() }

    private fun blobFile(bytes: ByteArray) = File(dir, "blob").also { it.writeBytes(bytes) }

    private fun created(url: String = "https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-0123456789abcdef0123456789abcdef", expires: Long = clock / 1000 + 3600) =
        MockResponse().setResponseCode(201).setBody("{\"id\":\"202611230347-0123456789abcdef0123456789abcdef\",\"expires\":$expires,\"url\":\"$url\",\"quota\":{}}")

    private fun status(code: Int, body: String = "{}") = MockResponse().setResponseCode(code).setBody(body)

    @Test fun uploadRequestVector() {
        val v = FileVectors.section("upload_request")
        val h = v["headers"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        val signer = Golden.keysOf(v.str("signer"))
        val c = FileClient({ signer }, { h["PA-ID"] }, offset, paClient = h.getValue("PA-Client"))
        val body = B64url.decode(v.str("body"))
        assertEquals(h["PA-File-SHA256"], FileCrypt.sha256(ByteArrayInputStream(body)))
        val got = c.uploadHeaders(h.getValue("PA-Time"), body.size.toLong(), h.getValue("PA-File-SHA256"), h.getValue("PA-Send-ID"))
        assertEquals(h.keys, got.keys)
        for (k in h.keys - "PA-Sig") assertEquals(k, h[k], got[k])
        val signed = Ids.fileUploadSigningBytes(h.getValue("PA-Time"), body.size.toLong(), h.getValue("PA-File-SHA256"), h.getValue("PA-Send-ID"))
        assertArrayEquals(B64url.decode(v.str("signed_bytes")), signed)
        assertTrue(P256.verify(B64url.decode(v.str("sign_pub")), signed, B64url.decode(got.getValue("PA-Sig"))))
        assertTrue(P256.verify(B64url.decode(v.str("sign_pub")), signed, B64url.decode(h.getValue("PA-Sig"))))
        val out = java.io.ByteArrayOutputStream()
        assertTrue(FileCrypt.open(B64url.decode(v.str("key")), ByteArrayInputStream(body), out))
        assertArrayEquals(B64url.decode(v.str("plaintext")), out.toByteArray())
    }

    /** Two automatic retries, each signed again with a new PA-Time; one PA-Send-ID; the body and Content-Length are the blob. */
    @Test fun uploadRetriesTwiceSignedAgain() {
        val blob = blobFile(ByteArray(39) { it.toByte() })
        val sha = FileCrypt.sha256(blob.inputStream())
        val send = FileClient.newSendId()
        assertEquals(22, send.length)
        server.enqueue(status(503))
        server.enqueue(status(502))
        server.enqueue(created())
        val r = client.upload(blob, sha, send)
        assertEquals("202611230347-0123456789abcdef0123456789abcdef", r.id)
        assertEquals(send, r.sendId)
        val times = HashSet<String>()
        repeat(3) {
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/v1/file", req.path)
            assertEquals("39", req.getHeader("Content-Length"))
            assertEquals(sha, req.getHeader("PA-File-SHA256"))
            assertEquals(send, req.getHeader("PA-Send-ID"))
            assertEquals(id, req.getHeader("PA-ID"))
            val t = req.getHeader("PA-Time")!!
            times += t
            assertTrue(P256.verify(keys.signPub, Ids.fileUploadSigningBytes(t, 39, sha, send), B64url.decode(req.getHeader("PA-Sig")!!)))
            assertArrayEquals(blob.readBytes(), req.body.readByteArray())
        }
        assertEquals(3, times.size)
        assertEquals(listOf(1000L, 3000L), slept)
    }

    @Test fun uploadReportsTheBytesSent() {
        val blob = blobFile(ByteArray(200_000) { it.toByte() })
        server.enqueue(created())
        val seen = ArrayList<Long>()
        client.upload(blob, "x", "s") { seen += it }
        assertTrue(seen.size > 1)
        assertEquals(seen.sorted(), seen)
        assertEquals(200_000L, seen.last())
        assertArrayEquals(blob.readBytes(), server.takeRequest().body.readByteArray())
    }

    @Test fun uploadStopsAfterThreeTries() {
        val blob = blobFile(ByteArray(30))
        repeat(3) { server.enqueue(status(500)) }
        val e = expectFileError { client.upload(blob, "x", "s") }
        assertEquals(FinalCode.FAILED, e.code)
        assertEquals(3, server.requestCount)
    }

    @Test fun clockSkewIsSignedAgainAndIsNotATry() {
        val blob = blobFile(ByteArray(30))
        server.enqueue(status(401, "{\"error\":\"clock skew\"}").setHeader("PA-Epoch", (clock / 1000 + 600).toString()))
        server.enqueue(status(500))
        server.enqueue(status(500))
        server.enqueue(created())
        client.upload(blob, "x", "s")
        assertEquals(4, server.requestCount)
        server.takeRequest()
        assertEquals((clock - slept.sum() + 600_000).toString(), server.takeRequest().getHeader("PA-Time"))
    }

    @Test fun uploadFinals() {
        val blob = blobFile(ByteArray(30))
        server.enqueue(status(429, "{\"error\":\"file quota\",\"retry_after\":7200}"))
        assertEquals("You reached your file limit. Try again in 2 hours", expectFileError { client.upload(blob, "x", "s") }.text)
        server.enqueue(status(503, "{\"error\":\"files paused\"}"))
        assertEquals("File sending is paused. Try again later", expectFileError { client.upload(blob, "x", "s") }.text)
        server.enqueue(status(403, "{\"error\":\"unapproved\"}"))
        val e = expectFileError { client.upload(blob, "x", "s") }
        assertEquals(403, e.status)
        assertEquals("unapproved", e.error)
        server.enqueue(created(url = "https://evil.example.com/x"))
        assertEquals(FinalCode.FAILED, expectFileError { client.upload(blob, "x", "s") }.code)
        assertEquals(4, server.requestCount)
        assertTrue(slept.isEmpty())
    }

    @Test fun rateLimitedWaitsTheGivenTime() {
        val blob = blobFile(ByteArray(30))
        server.enqueue(status(429, "{\"error\":\"rate limited\",\"retry_after\":7}"))
        server.enqueue(created())
        client.upload(blob, "x", "s")
        assertEquals(listOf(7000L), slept)
    }

    /** A retry of the same send after a 201 uses that url again while it has not expired. */
    @Test fun priorReplyIsReused() {
        val blob = blobFile(ByteArray(30))
        val prior = UploadReply("i", clock / 1000 + 10, "https://b2file.pusharmor.com/v1/x", "s")
        assertEquals(prior, client.upload(blob, "x", "s", prior))
        assertEquals(0, server.requestCount)
        server.enqueue(created())
        client.upload(blob, "x", "other", prior) // another send
        clock += 10_000
        server.enqueue(created())
        client.upload(blob, "x", "s", prior) // expired
        assertEquals(2, server.requestCount)
    }

    @Test fun uploadRefusesOverMaxFile() {
        val blob = File(dir, "big").also { java.io.RandomAccessFile(it, "rw").use { f -> f.setLength(FileCrypt.MAX_FILE + 29) } }
        assertEquals(FinalCode.TOO_LARGE, expectFileError { client.upload(blob, "x", "s") }.code)
        assertEquals(0, server.requestCount)
    }

    // ---- download ----

    private val blobBytes = ByteArray(1000) { (it * 7).toByte() }
    private fun ref(size: Long = 972, expires: Long = clock / 1000 + 600, url: String = "https://b2file.pusharmor.com/v1/k") =
        FileValue(url, expires, "k", "n", size, "s")
    private val part get() = File(dir, "part")

    @Test fun downloadWhole() {
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes)))
        assertEquals(FileClient.Fetch.Done, client.fetch(ref(), "a.pdf", part))
        assertArrayEquals(blobBytes, part.readBytes())
        assertNull(server.takeRequest().getHeader("Range"))
    }

    @Test fun downloadResumesWithRange() {
        part.writeBytes(blobBytes.copyOf(300))
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 300-999/1000").setBody(Buffer().write(blobBytes.copyOfRange(300, 1000))))
        assertEquals(FileClient.Fetch.Done, client.fetch(ref(), "a.pdf", part))
        assertEquals("bytes=300-", server.takeRequest().getHeader("Range"))
        assertArrayEquals(blobBytes, part.readBytes())
    }

    @Test fun aWholeReplyToARangeStartsOver() {
        part.writeBytes(ByteArray(300))
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes)))
        assertEquals(FileClient.Fetch.Done, client.fetch(ref(), "a.pdf", part))
        assertArrayEquals(blobBytes, part.readBytes())
    }

    @Test fun aWrongRangeDropsThePart() {
        part.writeBytes(ByteArray(300))
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 0-999/1000").setBody(Buffer().write(blobBytes)))
        assertEquals(FileClient.Fetch.Retry(null), client.fetch(ref(), "a.pdf", part))
        assertEquals(0L, part.length())
    }

    @Test fun cutOffKeepsTheBytes() {
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        assertEquals(FileClient.Fetch.Retry(null), client.fetch(ref(), "a.pdf", part))
        assertTrue(part.length() < 1000)
    }

    /** A read error met while stopping is a stop: the bytes that arrived do not cost an attempt. */
    @Test fun aReadErrorWhileStoppingIsAStop() {
        var stopNow = false
        val c = FileClient({ keys }, { id }, offset, server.url("/"), FileClient.defaultHttp().newBuilder().addInterceptor(Interceptor { chain ->
            val src = object : okio.Source {
                var sent = false
                override fun read(sink: Buffer, byteCount: Long): Long {
                    if (!sent) { sent = true; sink.write(blobBytes, 0, 100); return 100 }
                    stopNow = true
                    throw java.io.IOException("socket closed")
                }
                override fun timeout() = okio.Timeout.NONE
                override fun close() {}
            }
            okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK")
                .body(src.buffer().asResponseBody(null, 1000)).build()
        }).build(), { clock }, { })
        assertEquals(FileClient.Fetch.Stopped, c.fetch(ref(), "a.pdf", part) { stopNow })
        assertEquals(100L, part.length())
    }

    @Test fun wrongLengthIsDamaged() {
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes + ByteArray(5))))
        assertEquals(FileClient.Fetch.Damaged, client.fetch(ref(), "a.pdf", part))
        part.delete()
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes.copyOf(900))))
        assertEquals(FileClient.Fetch.Damaged, client.fetch(ref(), "a.pdf", part))
        part.writeBytes(ByteArray(10))
        server.enqueue(status(416))
        assertEquals(FileClient.Fetch.Damaged, client.fetch(ref(), "a.pdf", part))
    }

    @Test fun stopKeepsTheBytes() {
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes)))
        assertEquals(FileClient.Fetch.Stopped, client.fetch(ref(), "a.pdf", part) { true })
    }

    @Test fun downloadStatusTable() {
        server.enqueue(status(404).setHeader("PA-Epoch", (clock / 1000).toString()))
        assertEquals("Deleted", expectFileError { client.fetch(ref(), "a.pdf", part) }.text)
        // the corrected clock decides: the relay server's clock is past expires
        server.enqueue(status(404).setHeader("PA-Epoch", (clock / 1000 + 601).toString()))
        assertEquals("Expired", expectFileError { client.fetch(ref(), "a.pdf", part) }.text)
        server.enqueue(status(410))
        assertEquals(FinalCode.EXPIRED, expectFileError { client.fetch(ref(), "a.pdf", part) }.code)
        server.enqueue(status(404, "{\"error\":\"update required\"}"))
        assertEquals("Update the app", expectFileError { client.fetch(ref(), "a.pdf", part) }.text)
        server.enqueue(status(429, "{\"error\":\"rate limited\",\"retry_after\":9}"))
        assertEquals(FileClient.Fetch.Retry(9), client.fetch(ref(), "a.pdf", part))
        server.enqueue(status(502))
        assertEquals(FileClient.Fetch.Retry(null), client.fetch(ref(), "a.pdf", part))
    }

    @Test fun redirectsStayOnFileHosts() {
        server.enqueue(status(302).setHeader("Location", "https://b2file2.pusharmor.com/v1/k2"))
        server.enqueue(MockResponse().setBody(Buffer().write(blobBytes)))
        assertEquals(FileClient.Fetch.Done, client.fetch(ref(), "a.pdf", part))
        server.takeRequest()
        assertEquals("/v1/k2", server.takeRequest().path)
        part.delete()
        server.enqueue(status(302).setHeader("Location", "https://evil.example.com/v1/k"))
        assertEquals(FinalCode.DAMAGED, expectFileError { client.fetch(ref(), "a.pdf", part) }.code)
        for (bad in listOf("http://b2file.pusharmor.com/v1/k", "https://u:p@b2file.pusharmor.com/v1/k", "https://b2file.pusharmor.com:8443/v1/k", "https://pusharmor.com.evil.com/k")) {
            assertTrue(bad, !FileClient.fileUrlOk(bad))
            assertEquals(FinalCode.DAMAGED, expectFileError { client.fetch(ref(url = bad), "a.pdf", part) }.code)
        }
        assertTrue(FileClient.fileUrlOk("https://b2file.pusharmor.com:443/v1/k"))
    }

    @Test fun downloadRefusesOverMaxFile() {
        assertEquals(FinalCode.TOO_LARGE, expectFileError { client.fetch(ref(size = FileCrypt.MAX_FILE + 1), "a.pdf", part) }.code)
        assertEquals(0, server.requestCount)
    }

    private fun expectFileError(block: () -> Unit): FileError {
        try { block() } catch (e: FileError) { return e }
        fail("no FileError")
        throw IllegalStateException()
    }
}
