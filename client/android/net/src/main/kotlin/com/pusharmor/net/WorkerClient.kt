package com.pusharmor.net

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.KeyOps
import com.pusharmor.protocol.StrictJson
import com.pusharmor.protocol.engine.Api
import com.pusharmor.protocol.engine.ApiResult
import com.pusharmor.protocol.engine.ApproveReply
import com.pusharmor.protocol.engine.ListedPeer
import com.pusharmor.protocol.engine.PeersReply
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Worker clock offset: PA-Time = local now + offset, re-synced from PA-Epoch-Ms of every reply. */
interface ClockOffset {
    var offsetMs: Long
}

class MemoryClockOffset(override var offsetMs: Long = 0) : ClockOffset

/** Raw reply after retries. */
class Reply(val status: Int, val json: JsonObject?, val retryAfter: Long?)

/**
 * The Worker API client (api.pusharmor.com, /v1). Bodies are serialized once to bytes;
 * PA-Sig signs exactly those bytes and OkHttp sends the same array. Retries (429, 503,
 * network only; never 502) reuse the same bytes and signature inside an 8 s budget.
 */
class WorkerClient(
    private val keys: () -> KeyOps,
    private val ownId: () -> String?,
    private val offset: ClockOffset,
    private val base: HttpUrl = "https://api.pusharmor.com".toHttpUrl(),
    private val http: OkHttpClient = defaultHttp(),
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    /** Called for any call signed with PA-ID that gets 401 "unknown peer" or 401 "logged out" (the error text). */
    private val onAuthState: (String) -> Unit = {},
) : Api {
    companion object {
        const val BUDGET_MS = 8_000L
        /** Whole-call timeout of a single attempt inside the 10 s push handler (I299). */
        const val ONCE_TIMEOUT_MS = 5_000L
        /** Largest reply body read; a longer one is a network failure (I299). */
        const val MAX_BODY = 1L shl 20
        val BACKOFF_MS = longArrayOf(500, 1500, 3000)
        private val JSON = "application/json".toMediaType()

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()

        fun obj(vararg pairs: Pair<String, String>): String = pairs.joinToString(",", "{", "}") { (k, v) -> "${StrictJson.quote(k)}:$v" }
        fun str(s: String) = StrictJson.quote(s)
        fun map(m: Map<String, String>) = m.entries.joinToString(",", "{", "}") { "${str(it.key)}:${str(it.value)}" }
    }

    private val onceHttp by lazy { http.newBuilder().callTimeout(ONCE_TIMEOUT_MS, TimeUnit.MILLISECONDS).build() }

    /** PA-Time as 13 decimal digits. */
    fun paTime(): String = (now() + offset.offsetMs).toString().padStart(13, '0')

    /**
     * One call. [signed]: PA-ID + PA-Time + PA-Sig; [signedNoId]: PA-Time + PA-Sig only
     * (POST /peers, DELETE /account). [path] includes /v1 and no query. [once]: one attempt
     * with [ONCE_TIMEOUT_MS], no retry.
     */
    fun call(method: String, path: String, body: ByteArray?, signed: Boolean, signedNoId: Boolean = false, query: Map<String, String> = emptyMap(), once: Boolean = false): Reply? {
        val bytes = body ?: ByteArray(0)
        val url = base.newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val rb = Request.Builder().url(url)
        if (signed || signedNoId) {
            val t = paTime()
            val sig = keys().sign(Ids.requestSigningBytes(method, path, t, bytes))
            if (signed) rb.header("PA-ID", ownId() ?: return null)
            rb.header("PA-Time", t).header("PA-Sig", B64url.encode(sig))
        }
        rb.method(method, if (body != null || method == "POST" || method == "PATCH" || method == "DELETE") bytes.toRequestBody(JSON) else null)
        val req = rb.build()
        val start = now()
        var attempt = 0
        while (true) {
            var retryAfter: Long? = null
            val reply: Reply? = try {
                (if (once) onceHttp else http).newCall(req).execute().use { r ->
                    r.header("PA-Epoch-Ms")?.toLongOrNull()?.let { offset.offsetMs = it - now() }
                    val text = r.body?.let { readCapped(it) }.orEmpty()
                    val json = try { Json.parseToJsonElement(text) as? JsonObject } catch (e: Exception) { null }
                    retryAfter = r.header("Retry-After")?.toLongOrNull() ?: json?.get("retry_after")?.jsonPrimitive?.longOrNull
                    Reply(r.code, json, retryAfter)
                }
            } catch (e: BodyTooLarge) {
                return null // a hostile or broken reply: not retried
            } catch (e: IOException) {
                null
            }
            if (signed && reply != null && reply.status == 401) {
                val err = (reply.json?.get("error") as? JsonPrimitive)?.content
                if (err == "unknown peer" || err == "logged out") onAuthState(err)
            }
            val retryable = reply == null || reply.status == 429 || reply.status == 503
            if (once || !retryable || attempt >= BACKOFF_MS.size) return reply
            val wait = maxOf(BACKOFF_MS[attempt], (retryAfter ?: 0) * 1000)
            if (now() - start + wait > BUDGET_MS) return reply
            sleep(wait)
            attempt++
        }
    }

    private class BodyTooLarge : IOException("reply body over cap")

    private fun readCapped(b: ResponseBody): String {
        val src = b.source()
        if (src.request(MAX_BODY + 1)) throw BodyTooLarge()
        return src.buffer.readUtf8()
    }

    private fun <T> result(reply: Reply?, parse: (JsonObject) -> T): ApiResult<T> {
        if (reply == null) return ApiResult.Network
        val j = reply.json
        if (reply.status in 200..299) {
            return try {
                ApiResult.Ok(parse(j ?: JsonObject(emptyMap())), pushMissing = j?.get("push_missing")?.jsonPrimitive?.booleanOrNull == true)
            } catch (e: Exception) {
                ApiResult.Http(reply.status, "bad reply")
            }
        }
        val ids = (j?.get("ids") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
        return ApiResult.Http(reply.status, (j?.get("error") as? JsonPrimitive)?.content, reply.retryAfter, ids)
    }

    private fun results(j: JsonObject): Map<String, String> =
        (j["r"] as? JsonObject)?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap()

    private fun approveReply(j: JsonObject) = ApproveReply(j["r"]!!.jsonPrimitive.content, (j["c"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content)

    private fun me() = ownId() ?: ""

    override fun send(messages: Map<String, String>) =
        result(call("POST", "/v1/send", obj("v" to "1", "m" to map(messages)).toByteArray(), true), ::results)

    override fun approve(x: String, body: ByteArray) = result(call("POST", "/v1/approve/$x", body, true), ::approveReply)

    override fun deny(x: String, c: String) = result(call("POST", "/v1/deny/$x", obj("c" to str(c)).toByteArray(), true), ::approveReply)

    override fun withdraw(x: String) = result(call("POST", "/v1/deny/$x", obj("withdraw" to "1").toByteArray(), true), ::approveReply)

    override fun pair(x: String, kind: String, c: String) =
        result(call("POST", "/v1/pair/$x", obj("k" to str(kind), "c" to str(c)).toByteArray(), true)) { it["r"]!!.jsonPrimitive.content }

    override fun peers() = result(call("GET", "/v1/peers", null, true), ::peersReply)

    /** GET /peers from the push handler: one attempt within [ONCE_TIMEOUT_MS]. */
    fun peersOnce() = result(call("GET", "/v1/peers", null, true, once = true), ::peersReply)

    override fun logout(messages: Map<String, String>) =
        result(call("POST", "/v1/peers/${me()}/logout", obj("m" to map(messages)).toByteArray(), true), ::results)

    override fun login(ticket: String, messages: Map<String, String>) =
        result(call("POST", "/v1/peers/${me()}/login", obj("ticket" to str(ticket), "m" to map(messages)).toByteArray(), true), ::results)

    override fun rename(names: Map<String, String>, messages: Map<String, String>) =
        result(call("PATCH", "/v1/peers/${me()}", obj("name" to map(names), "m" to map(messages)).toByteArray(), true), ::results)

    override fun deletePeer(id: String, messages: Map<String, String>) =
        result(call("DELETE", "/v1/peers/$id", obj("m" to map(messages)).toByteArray(), true), ::results)

    /** PATCH push: {"push": {...} | null}. [pushJson] is the serialized push object or "null". */
    fun patchPush(pushJson: String) = result(call("PATCH", "/v1/peers/${me()}", obj("push" to pushJson).toByteArray(), true)) { }

    fun confirm(code: String) = result(call("POST", "/v1/peers/${me()}/confirm", obj("code" to str(code)).toByteArray(), true)) { }

    class Registered(val id: String, val peers: PeersReply)

    /** 409 "peer limit": a fresh 10-min ticket and the account's peers for the picker. */
    class PeerLimit(val ticket: String, val peers: List<ListedPeer>)

    sealed class RegisterResult {
        class Ok(val registered: Registered) : RegisterResult()
        class Limit(val limit: PeerLimit) : RegisterResult()
        class Error(val result: ApiResult<*>) : RegisterResult()
    }

    /** POST /peers, signed by the new key, no PA-ID; push null (registration never waits for a token). */
    fun register(ticket: String, signPub: String, encPub: String, evict: List<String>? = null): RegisterResult {
        val parts = mutableListOf("ticket" to str(ticket), "sign_pub" to str(signPub), "enc_pub" to str(encPub), "platform" to str("android"), "push" to "null")
        if (evict != null) parts += "evict" to evict.joinToString(",", "[", "]") { str(it) }
        val reply = call("POST", "/v1/peers", obj(*parts.toTypedArray()).toByteArray(), signed = false, signedNoId = true)
        val j = reply?.json
        if (reply != null && reply.status == 409 && (j?.get("error") as? JsonPrimitive)?.content == "peer limit") {
            val peers = (j["peers"] as? JsonArray)?.mapNotNull { listed(it) } ?: emptyList()
            return RegisterResult.Limit(PeerLimit(j["ticket"]!!.jsonPrimitive.content, peers))
        }
        return when (val r = result(reply) { Registered(it["id"]!!.jsonPrimitive.content, peersReply(it)) }) {
            is ApiResult.Ok -> RegisterResult.Ok(r.value)
            else -> RegisterResult.Error(r)
        }
    }

    /** DELETE /account with a delete-account ticket; signed by the ticket key, no PA-ID. */
    fun deleteAccount(ticket: String, signPub: String, messages: Map<String, String>) =
        result(call("DELETE", "/v1/account", obj("ticket" to str(ticket), "sign_pub" to str(signPub), "m" to map(messages)).toByteArray(), signed = false, signedNoId = true), ::results)

    class Ticket(val ticket: String, val email: String?)

    fun authEmail(email: String, signPub: String, purpose: String, turnstile: String) =
        result(call("POST", "/v1/auth/email", obj("email" to str(email), "sign_pub" to str(signPub), "purpose" to str(purpose), "turnstile" to str(turnstile)).toByteArray(), false)) {
            it["request_token"]!!.jsonPrimitive.content
        }

    fun authEmailVerify(requestToken: String, code: String) =
        result(call("POST", "/v1/auth/email/verify", obj("request_token" to str(requestToken), "code" to str(code)).toByteArray(), false), ::ticket)

    fun authGoogleToken(idToken: String, signPub: String, purpose: String) =
        result(call("POST", "/v1/auth/google/token", obj("id_token" to str(idToken), "sign_pub" to str(signPub), "purpose" to str(purpose)).toByteArray(), false), ::ticket)

    private fun ticket(j: JsonObject) = Ticket(j["ticket"]!!.jsonPrimitive.content, (j["email"] as? JsonPrimitive)?.content)

    /** Custom Tab URL for Worker-hosted OAuth (Google without Play services, Apple). */
    fun oauthUrl(provider: String, signPub: ByteArray, purpose: String): String =
        base.newBuilder().encodedPath("/v1/auth/$provider").addQueryParameter("k", Ids.oauthK(signPub))
            .addQueryParameter("r", "android").addQueryParameter("p", purpose).build().toString()

    fun peersReply(j: JsonObject): PeersReply = PeersReply(
        myPushSha256 = (j["my_push_sha256"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content,
        myAllow = (j["my_allow"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList(),
        peers = (j["peers"] as? JsonArray)?.mapNotNull { e -> listed(e) } ?: emptyList(),
    )

    private fun listed(e: JsonElement): ListedPeer? = try {
        val o = e.jsonObject
        fun s(k: String) = o[k]!!.jsonPrimitive.content
        fun b(k: String) = o[k]?.jsonPrimitive?.booleanOrNull == true
        fun l(k: String) = o[k]?.jsonPrimitive?.longOrNull ?: 0
        ListedPeer(s("id"), s("sign_pub"), s("enc_pub"), s("platform"), l("created"), b("logged_out"), l("approves").toInt(), l("approved_by").toInt(),
            b("approves_me"), b("denies_me"), b("reachable"), (o["name_for_me"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content,
            o["listening"]?.jsonPrimitive?.booleanOrNull != false)
    } catch (ex: Exception) {
        null
    }
}

/** Catalog error words -> UI strings. */
object ErrorText {
    fun of(r: ApiResult<*>): String = when (r) {
        is ApiResult.Ok -> ""
        ApiResult.Network -> "No connection. Try again."
        is ApiResult.Http -> when {
            r.status == 401 && r.error == "clock skew" -> "This device's clock is off by more than 5 minutes"
            r.status == 401 && r.error == "logged out" -> "Logged out. Log in to resume"
            r.status == 401 && r.error == "ticket expired" -> "Login expired, log in again"
            r.status == 401 && r.error == "unknown peer" -> "This device was removed. Log in again"
            r.status == 400 && r.error == "bad email" -> "Only email addresses with plain ASCII characters are supported."
            r.status == 400 && r.error == "push endpoint not allowed" -> "This browser's push service is not supported yet"
            r.status == 413 -> "Too long"
            r.status == 429 -> "Rate limited. Try again in ${r.retryAfter ?: 60} s"
            r.status == 502 -> "could not send the email, try again"
            r.status == 403 && r.error == "banned" -> "This account is blocked"
            else -> "Error: ${r.error ?: r.status}"
        }
    }
}
