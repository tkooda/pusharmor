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

/** Worker clock offset in seconds: PA-Time = local now + offset, re-synced from PA-Epoch (unix s) of every reply. */
interface ClockOffset {
    var offsetS: Long
}

/** Raw reply after retries. */
class Reply(val status: Int, val json: JsonObject?, val retryAfter: Long?, val tooLarge: Boolean = false)

/**
 * The Worker API client (api.pusharmor.com, /v1). Bodies are serialized once to bytes;
 * PA-Sig signs exactly those bytes and OkHttp sends the same array. Retries reuse the same
 * bytes and signature: a 429 waits the server-given time inside an 8 s budget; a 5xx or
 * network failure is tried 3 times in all, 1 s then 3 s apart ([FAULT_RETRY_MS]).
 */
class WorkerClient(
    private val keys: () -> KeyOps,
    private val ownId: () -> String?,
    private val offset: ClockOffset,
    private val base: HttpUrl = "https://api.pusharmor.com".toHttpUrl(),
    private val http: OkHttpClient = defaultHttp(),
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    /**
     * Called for any call signed with PA-ID that gets 401 "unknown peer" or 401 "logged out" (the error text).
     * false: the reply is not passed on and the call reads as no reply.
     */
    private val onAuthState: (String) -> Boolean = { true },
    /** PA-Client header value sent on every request: "android/<versionName>". */
    private val paClient: String = "android/0.0.0",
    /** Called for any call that gets HTTP 426: this app version is too old for the relay server. */
    private val onUpdateRequired: () -> Unit = {},
    /** Called for any reply that says push_missing: the relay server holds no push address for this device. */
    private val onPushMissing: () -> Unit = {},
) : Api {
    /** Set while a screen shows send progress: gets 50 (connected), 75 (request sent), 100 (reply in) as each call proceeds. */
    @Volatile var onProgress: ((Int) -> Unit)? = null

    companion object {
        const val BUDGET_MS = 8_000L
        /** Whole-call timeout of a single attempt inside the 10 s push handler. */
        const val ONCE_TIMEOUT_MS = 5_000L
        /** Largest reply body read; a longer one is a network failure. */
        const val MAX_BODY = 1L shl 20
        val BACKOFF_MS = longArrayOf(500, 1500, 3000)
        /** Waits before the 2nd and 3rd try after a 5xx or network failure. */
        val FAULT_RETRY_MS = longArrayOf(1000, 3000)
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

    private fun stepped(c: OkHttpClient): OkHttpClient {
        val p = onProgress ?: return c
        return c.newBuilder().eventListener(object : okhttp3.EventListener() {
            // Fires for a new connection once it is ready and at once for a pooled one.
            override fun connectionAcquired(call: okhttp3.Call, connection: okhttp3.Connection) = p(50)
            override fun requestBodyEnd(call: okhttp3.Call, byteCount: Long) = p(75)
            override fun responseBodyEnd(call: okhttp3.Call, byteCount: Long) = p(100)
        }).build()
    }

    /** PA-Time as 13 decimal digits. */
    fun paTime(): String = (now() + offset.offsetS * 1000).toString().padStart(13, '0')

    /**
     * One call. [signed]: PA-ID + PA-Time + PA-Sig; [signedNoId]: PA-Time + PA-Sig only
     * (POST /peers, DELETE /account). [path] includes /v1 and no query. [once]: one attempt
     * with [ONCE_TIMEOUT_MS], no retry. [retry] false: a call the server must not see twice is not retried.
     */
    fun call(method: String, path: String, body: ByteArray?, signed: Boolean, signedNoId: Boolean = false, query: Map<String, String> = emptyMap(), once: Boolean = false, retry: Boolean = true): Reply? {
        val bytes = body ?: ByteArray(0)
        val url = base.newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val rb = Request.Builder().url(url).header("PA-Client", paClient)
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
        var faults = 0
        while (true) {
            var retryAfter: Long? = null
            var code = 0
            val reply: Reply? = try {
                stepped(if (once) onceHttp else http).newCall(req).execute().use { r ->
                    r.header("PA-Epoch")?.toLongOrNull()?.let { offset.offsetS = it - now() / 1000 }
                    code = r.code
                    val text = r.body?.let { readCapped(it) }.orEmpty()
                    val json = try { Json.parseToJsonElement(text) as? JsonObject } catch (e: Exception) { null }
                    // Clamped to 0..1 hour, so a bad value cannot hold a call back for ever.
                    retryAfter = (r.header("Retry-After")?.toLongOrNull() ?: json?.get("retry_after")?.jsonPrimitive?.longOrNull)?.coerceIn(0L, 3600L)
                    Reply(r.code, json, retryAfter)
                }
            } catch (e: BodyTooLarge) {
                return Reply(code, null, null, tooLarge = true) // a hostile or broken reply: not retried
            } catch (e: IOException) {
                null
            }
            if (signed && reply != null && reply.status == 401) {
                val err = (reply.json?.get("error") as? JsonPrimitive)?.content
                if ((err == "unknown peer" || err == "logged out") && !onAuthState(err)) return null
            }
            if (reply?.status == 426) onUpdateRequired()
            if (once || !retry) return reply
            if (reply == null || reply.status in 500..599) {
                if (faults >= FAULT_RETRY_MS.size) return reply
                sleep(FAULT_RETRY_MS[faults++])
                continue
            }
            if (reply.status != 429 || attempt >= BACKOFF_MS.size) return reply
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
        if (reply.tooLarge) return ApiResult.Http(reply.status, "bad reply")
        val j = reply.json
        if (reply.status in 200..299) {
            return try {
                val missing = j?.get("push_missing")?.jsonPrimitive?.booleanOrNull == true
                if (missing) onPushMissing()
                ApiResult.Ok(parse(j ?: JsonObject(emptyMap())), pushMissing = missing)
            } catch (e: Exception) {
                ApiResult.Http(reply.status, "bad reply")
            }
        }
        val ids = (j?.get("ids") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
        return ApiResult.Http(reply.status, (j?.get("error") as? JsonPrimitive)?.content, reply.retryAfter, ids, (j?.get("account") as? JsonPrimitive)?.content)
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

    /** One test push to this device's stored push address: "sent" | "relay" | "gone" | "none" | "failed". */
    fun check() = result(call("POST", "/v1/peers/${me()}/check", obj().toByteArray(), true)) { it["result"]!!.jsonPrimitive.content }

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
        removed = (j["removed"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { k to it } }?.toMap() ?: emptyMap(),
        myRelayFault = (j["my_relay_fault"] as? JsonPrimitive)?.booleanOrNull == true,
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

/** Catalog error words -> UI strings: line 1 says what could not be done, line 2 ([reason]) says why. */
object ErrorText {
    const val UNREACHABLE = "The relay server could not be reached. Check your internet connection and try again."
    const val SERVER_DOWN = "The relay server is not working right now. Try again later."
    /** Text for HTTP 426. */
    const val UPDATE = "This version of PushArmor is too old. Update PushArmor to continue."
    const val REMOVED = "This device was removed from the account. Log in again."
    const val LOGGED_OUT = "This device is logged out. Log in to resume."
    const val LOGIN_EXPIRED = "The login expired. Log in again."
    const val BAD_LINK = "The login link is not valid. Request a new code and try again."
    const val CLOCK_OFF = "This device's clock is off by more than 5 minutes. Fix the clock and try again."
    const val BLOCKED = "This account is blocked."
    const val WRONG_CODE = "The code is not correct. Check the newest email from PushArmor and try again."
    const val CODE_EXPIRED = "The code expired. Request a new code to continue."
    const val SECURITY_CHECK = "The security check did not finish. Try again."
    const val EMAIL_NOT_SENT = "The relay server could not send the email. Try again."
    const val BAD_EMAIL = "Only email addresses with plain ASCII characters are supported."
    const val EMAIL_NOT_VERIFIED = "This Google account has no verified email address."
    const val GOOGLE_NOT_CONFIRMED = "Google did not confirm the login. Try again."
    /** A login ticket for another account than this device's. */
    const val ACCOUNT_MISMATCH = "This login is for another account."
    const val BAD_REPLY = "The relay server sent a reply this device cannot use. Try again."
    const val REFUSED = "The relay server did not accept the request. Update PushArmor and try again."
    const val TOO_LONG = "The message is longer than 2048 characters."
    const val PUSH_NOT_SUPPORTED = "This device's push service is not supported yet."
    const val KEYS_UNUSABLE = "This device's security keys cannot be used right now. Restart the device and try again."
    const val STORAGE_FULL = "Storage is full. Free some space and try again."
    const val SAVE_FAILED = "PushArmor could not save its data on this device. Restart PushArmor and try again."
    const val SAVE_DENIED = "PushArmor is not allowed to save there. Choose another location."
    /** Any other or unexpected failure: no reason sentence. */
    const val TRY_AGAIN = "Try again."

    /** Two lines: [action] ("Unable to send.") and [reason]. */
    fun text(action: String, reason: String): String = action + "\n" + reason

    /** [action] and the reason for [r]. */
    fun of(action: String, r: ApiResult<*>, pushHost: String? = null): String = text(action, reason(r, pushHost))

    /**
     * Why a call failed. A 2xx reply reaches here only when its body could not be used. A failed id check
     * (401 "bad id") is not a removal: it gets [REFUSED]. [pushHost] is added as a third line
     * to an unsupported push service.
     */
    fun reason(r: ApiResult<*>, pushHost: String? = null): String = when (r) {
        is ApiResult.Ok -> BAD_REPLY
        ApiResult.Network -> UNREACHABLE
        is ApiResult.Http -> when {
            r.error == "bad reply" || r.status in 200..299 -> BAD_REPLY
            r.status == 426 -> UPDATE
            r.status == 429 -> tooMany(r.retryAfter ?: 60)
            r.status == 413 -> TOO_LONG
            r.status == 401 && r.error == "clock skew" -> CLOCK_OFF
            r.status == 401 && r.error == "unknown peer" -> REMOVED
            r.status == 401 && r.error == "logged out" -> LOGGED_OUT
            r.status == 401 && (r.error == "invalid client signature" || r.error == "bad id") -> REFUSED
            r.status == 401 && r.error == "ticket expired" -> LOGIN_EXPIRED
            r.status == 401 && (r.error == "invalid ticket" || r.error == "bad ticket") -> BAD_LINK
            r.status == 401 && r.error == "wrong code" -> WRONG_CODE
            r.status == 401 && r.error == "code expired" -> CODE_EXPIRED
            r.status == 401 && r.error == "email not verified" -> EMAIL_NOT_VERIFIED
            r.status == 401 && r.error == "invalid id_token" -> GOOGLE_NOT_CONFIRMED
            r.status == 401 && r.error == "account mismatch" -> ACCOUNT_MISMATCH
            r.status == 403 && r.error == "banned" -> BLOCKED
            r.status == 403 && r.error == "turnstile failed" -> SECURITY_CHECK
            r.status == 400 && r.error == "bad email" -> BAD_EMAIL
            r.status == 400 && r.error == "push endpoint not allowed" -> PUSH_NOT_SUPPORTED + (pushHost?.let { "\n($it)" } ?: "")
            (r.status == 400 && r.error == "bad request") || r.status == 404 || r.status == 405 -> REFUSED
            r.status == 502 && r.error == "email send failed" -> EMAIL_NOT_SENT
            r.status in 500..599 -> SERVER_DOWN
            else -> TRY_AGAIN
        }
    }

    /** Wait text: over 60 s whole minutes rounded up, else whole seconds rounded up; same words as the other clients. */
    fun wait(ms: Long): String {
        val s = maxOf(1L, (ms + 999) / 1000)
        if (s > 60) { val m = (s + 59) / 60; return if (m == 1L) "1 minute" else "$m minutes" }
        return if (s == 1L) "1 second" else "$s seconds"
    }

    /** HTTP 429: "Too many tries. Try again in 2 minutes." or "... in 30 seconds.". */
    fun tooMany(seconds: Long): String = "Too many tries. Try again in ${wait(seconds * 1000)}."
}
