package com.pusharmor.net

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.FileCrypt
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.KeyOps
import com.pusharmor.protocol.FileRules
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/** A final file transfer error: no automatic retry. [status] (0 = no reply) and [error] are the reply's, for refusals the caller handles. */
class FileError(val code: FinalCode, val text: String?, val status: Int = 0, val error: String = "") : Exception(code.name + (text?.let { ": $it" } ?: ""))

/** One quota window of a 201 reply: uploads used, the limit, and when it resets (Unix seconds). */
data class QuotaWindow(val used: Long, val limit: Long, val resetsAt: Long)

/**
 * The 201 reply of POST /v1/file, kept with the send's PA-Send-ID so a retry of the same send can use it again;
 * [day] and [month] are its quota block (null when missing or malformed).
 */
data class UploadReply(val id: String, val expires: Long, val url: String, val sendId: String, val day: QuotaWindow? = null, val month: QuotaWindow? = null)

/**
 * File transfers: POST /v1/file (PA-FILE1, one PA-Send-ID per send, at most 2 automatic retries, each signed
 * again) and the file GET (Range resume into a private file).
 */
class FileClient(
    private val keys: () -> KeyOps,
    private val ownId: () -> String?,
    private val offset: ClockOffset,
    private val base: HttpUrl = "https://api.pusharmor.com".toHttpUrl(),
    private val http: OkHttpClient = defaultHttp(),
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    /** PA-Client header value: "android/<versionName>". */
    private val paClient: String = "android/0.0.0",
    /** Called for 401 "unknown peer" or "logged out" (the error text) on an upload. */
    private val onAuthState: (String) -> Unit = {},
    /** Called for HTTP 426: this app version is too old for the relay server. */
    private val onUpdateRequired: () -> Unit = {},
) {
    companion object {
        /** Waits between upload tries when the reply names none. */
        val UPLOAD_WAITS_MS = longArrayOf(1000, 3000)
        /** No wait between tries is longer than this. */
        const val MAX_WAIT_MS = 60_000L
        /** One file request may take this long before it is aborted. */
        const val FILE_TIMEOUT_MS = 30 * 60 * 1000L
        /** Redirects followed on a file GET, each to a file host. */
        const val MAX_REDIRECTS = 5
        private const val CHUNK = 64 * 1024
        private val OCTETS = "application/octet-stream".toMediaType()
        private val random = SecureRandom()

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(FILE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()

        /** A new PA-Send-ID: 22-char b64url of 16 random bytes, one per send, the same on each retry. */
        fun newSendId(): String = B64url.encode(ByteArray(16).also { random.nextBytes(it) })

        /** A file URL: https on a pusharmor.com host, port 443, no user name or password. */
        fun fileUrlOk(url: String): Boolean {
            if (!url.startsWith("https://", ignoreCase = true)) return false
            val u = url.toHttpUrlOrNull() ?: return false
            return u.isHttps && u.host.endsWith(".pusharmor.com") && u.port == 443 && u.username.isEmpty() && u.password.isEmpty()
        }
    }

    /** Server clock in Unix seconds (local clock + PA-Epoch offset). */
    fun nowSec(): Long = now() / 1000 + offset.offsetS

    /** PA-Time as 13 decimal digits. */
    private fun paTime(): String = (now() + offset.offsetS * 1000).toString().padStart(13, '0')

    /** Headers of a POST /v1/file, PA-Sig over the PA-FILE1 string. Content-Length is listed for the signature; OkHttp sets it from the body. */
    fun uploadHeaders(paTime: String, length: Long, sha256: String, sendId: String, id: String = ownId() ?: throw FileError(FinalCode.FAILED, null)): Map<String, String> {
        val sig = keys().sign(Ids.fileUploadSigningBytes(paTime, length, sha256, sendId))
        return linkedMapOf(
            "PA-Client" to paClient,
            "PA-ID" to id,
            "PA-Time" to paTime,
            "Content-Length" to length.toString(),
            "PA-File-SHA256" to sha256,
            "PA-Send-ID" to sendId,
            "PA-Sig" to B64url.encode(sig),
        )
    }

    private class Got(val status: Int, val json: JsonObject?) {
        val error: String? get() = (json?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content
        /** retry_after in seconds when a positive integer, else null. */
        val retryAfter: Long? get() = (json?.get("retry_after") as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it > 0 }
    }

    private fun epoch(r: Response) {
        r.header("PA-Epoch")?.takeIf { it.length in 1..13 && it.all { c -> c in '0'..'9' } }?.let { offset.offsetS = it.toLong() - now() / 1000 }
    }

    private fun jsonOf(r: Response): JsonObject? = try {
        val src = r.body?.source() ?: return null
        src.request(4096)
        Json.parseToJsonElement(src.buffer.readUtf8(minOf(src.buffer.size, 4096))) as? JsonObject
    } catch (e: Exception) {
        null
    }

    /**
     * Uploads one blob file. [prior]: the 201 reply of an earlier try of the same send; it is used again (no new
     * upload) while it has not expired by the corrected clock. Throws [FileError].
     */
    fun upload(blob: File, sha256: String, sendId: String, prior: UploadReply? = null): UploadReply {
        if (prior != null && prior.sendId == sendId && nowSec() < prior.expires) return prior
        val length = blob.length()
        if (length > FileCrypt.MAX_FILE + FileCrypt.BLOB_OVERHEAD) throw FileError(FinalCode.TOO_LARGE, null, 413)
        var tries = 0
        var skewed = false
        while (true) {
            val rb = Request.Builder().url(base.newBuilder().encodedPath("/v1/file").build())
            for ((k, v) in uploadHeaders(paTime(), length, sha256, sendId)) if (k != "Content-Length") rb.header(k, v)
            val req = rb.post(blob.asRequestBody(OCTETS)).build()
            val got = try {
                http.newCall(req).execute().use { r -> epoch(r); Got(r.code, jsonOf(r)) }
            } catch (e: IOException) {
                Got(0, null)
            }
            if (got.status == 401 && got.error == "clock skew" && !skewed) {
                skewed = true // signed again with the new offset; not one of the tries
                continue
            }
            if (got.status in 200..299) {
                val j = got.json
                val id = (j?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content
                val url = (j?.get("url") as? JsonPrimitive)?.takeIf { it.isString }?.content
                val expires = (j?.get("expires") as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
                if (id == null || url == null || !fileUrlOk(url) || expires == null || expires < 0 || expires > (1L shl 53) - 1) throw FileError(FinalCode.FAILED, null, got.status)
                val quota = j?.get("quota") as? JsonObject
                return UploadReply(id, expires, url, sendId, window(quota?.get("day")), window(quota?.get("month")))
            }
            if (got.status == 401 && (got.error == "unknown peer" || got.error == "logged out")) onAuthState(got.error!!)
            if (got.status == 426) onUpdateRequired()
            when (val o = FileRules.fileStatus(true, got.status, got.error, got.retryAfter)) {
                is FileRules.Outcome.Final -> throw FileError(o.code, o.text, got.status, got.error.orEmpty())
                is FileRules.Outcome.Retry -> {
                    if (++tries >= FileRules.UPLOAD_TRIES) throw FileError(FinalCode.FAILED, null, got.status, got.error.orEmpty())
                    sleep(minOf(o.wait?.let { it * 1000 } ?: UPLOAD_WAITS_MS[tries - 1], MAX_WAIT_MS))
                }
            }
        }
    }

    private fun window(e: kotlinx.serialization.json.JsonElement?): QuotaWindow? {
        val o = e as? JsonObject ?: return null
        fun n(k: String) = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 }
        return QuotaWindow(n("used") ?: return null, n("limit") ?: return null, n("resets_at") ?: return null)
    }

    /** What one file GET did. */
    sealed class Fetch {
        /** [part] holds the whole blob (size and hash not yet checked). */
        object Done : Fetch()
        /** An error to retry later; [wait] is the reply's retry_after in seconds. Bytes that arrived are kept. */
        data class Retry(val wait: Long?) : Fetch()
        /** The reply was longer or shorter than the blob, or the server refused the stored range: download it again. */
        object Damaged : Fetch()
        /** [stop] said to stop; bytes that arrived are kept. */
        object Stopped : Fetch()
    }

    /**
     * One GET of the blob of [f] into [part], resuming with Range from the bytes it holds. [name] is the sanitized
     * name for the storage-full text. Final refusals throw [FileError].
     */
    fun fetch(f: FileValue, name: String, part: File, stop: () -> Boolean = { false }): Fetch {
        if (f.size > FileCrypt.MAX_FILE) throw FileError(FinalCode.TOO_LARGE, null)
        if (!fileUrlOk(f.url)) throw FileError(FinalCode.DAMAGED, FileRules.FILE_DAMAGED)
        val want = f.size + FileCrypt.BLOB_OVERHEAD
        var have = part.length()
        if (have > want) { truncate(part, 0); have = 0 }
        if (have == want) return Fetch.Done
        var url = f.url.toHttpUrl()
        var hops = 0
        while (true) {
            val rb = Request.Builder().url(url).header("PA-Client", paClient)
            if (have > 0) rb.header("Range", "bytes=$have-")
            val res = try { http.newCall(rb.get().build()).execute() } catch (e: IOException) { return retryOrFinal(Got(0, null), f) }
            res.use { r ->
                epoch(r)
                if (r.code in 300..399 && r.header("Location") != null) {
                    val next = url.resolve(r.header("Location")!!)
                    if (next == null || !fileUrlOk(next.toString()) || ++hops > MAX_REDIRECTS) throw FileError(FinalCode.DAMAGED, FileRules.FILE_DAMAGED, r.code)
                    url = next
                    return@use
                }
                if (r.code == 416) return Fetch.Damaged // the stored part is longer than the object
                if (r.code == 206 && !(r.header("Content-Range") ?: "").startsWith("bytes $have-")) {
                    truncate(part, 0) // not the asked range: start again
                    return Fetch.Retry(null)
                }
                if (r.code != 200 && r.code != 206) return retryOrFinal(Got(r.code, jsonOf(r)), f)
                if (r.code == 200 && have > 0) { truncate(part, 0); have = 0 }
                return readInto(r, f, name, part, have, want, stop)
            }
        }
    }

    private fun retryOrFinal(got: Got, f: FileValue): Fetch {
        if (got.status == 426) onUpdateRequired()
        return when (val o = FileRules.fileStatus(false, got.status, got.error, got.retryAfter, nowSec(), f.expires)) {
            is FileRules.Outcome.Final -> throw FileError(o.code, o.text, got.status, got.error.orEmpty())
            is FileRules.Outcome.Retry -> Fetch.Retry(o.wait)
        }
    }

    private fun truncate(part: File, len: Long) {
        if (!part.exists()) return
        RandomAccessFile(part, "rw").use { it.setLength(len) }
    }

    /** Appends the reply body to [part]; a cut-off body keeps what arrived. */
    private fun readInto(r: Response, f: FileValue, name: String, part: File, start: Long, want: Long, stop: () -> Boolean): Fetch {
        val body = r.body ?: return Fetch.Retry(null)
        val buf = ByteArray(CHUNK)
        var have = start
        var ended = false
        var stopped = false
        try {
            FileOutputStream(part, true).use { out ->
                val src = body.byteStream()
                while (true) {
                    if (stop()) { stopped = true; break }
                    // cut off; a stop met at that point is a stop (its bytes do not cost an attempt)
                    val n = try { src.read(buf) } catch (e: IOException) { stopped = stop(); break }
                    if (n < 0) { ended = true; break }
                    out.write(buf, 0, n)
                    have += n
                    if (have > want) break
                }
            }
        } catch (e: IOException) {
            // a write failed: the disk is full, else try again later
            if ((part.absoluteFile.parentFile?.usableSpace ?: 0) < want - have) throw FileError(FinalCode.STORAGE, FileRules.storageFullText(false, name))
            return Fetch.Retry(null)
        }
        if (have > want || (ended && have < want)) return Fetch.Damaged // too long, or a whole reply that is too short
        if (have == want) return Fetch.Done
        return if (stopped) Fetch.Stopped else Fetch.Retry(null)
    }
}
