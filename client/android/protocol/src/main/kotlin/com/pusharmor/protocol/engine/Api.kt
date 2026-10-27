package com.pusharmor.protocol.engine

/**
 * Outcome of one signed Worker call after the client's own retries (429 / 503 / network,
 * inside the 8 s budget). Implemented by :net.
 */
sealed class ApiResult<out T> {
    data class Ok<T>(val value: T, val pushMissing: Boolean = false) : ApiResult<T>()

    /** HTTP error with the catalog error word; [retryAfter] seconds on 429; [ids] on 400 "messages missing". */
    data class Http(val status: Int, val error: String?, val retryAfter: Long? = null, val ids: List<String> = emptyList()) : ApiResult<Nothing>()

    /** No reply (offline, timeout, TLS). */
    object Network : ApiResult<Nothing>()

    val isClockSkew: Boolean get() = this is Http && status == 401 && error == "clock skew"
    val isPaused: Boolean get() = this is Http && status == 401 && error == "paused"
    val isUnknownPeer: Boolean get() = this is Http && status == 401 && error == "unknown peer"
    val isMessagesMissing: Boolean get() = this is Http && status == 400 && error == "messages missing"
}

/** Reply of POST /approve and POST /deny: "r" and, for approve, the returned "c". */
data class ApproveReply(val result: String, val c: String? = null)

/** One entry of GET /peers. */
data class ListedPeer(
    val id: String,
    val signPub: String,
    val encPub: String,
    val platform: String,
    val created: Long,
    val paused: Boolean,
    val approves: Int,
    val approvedBy: Int,
    val approvesMe: Boolean,
    val deniesMe: Boolean,
    val reachable: Boolean,
    val nameForMe: String?,
)

data class PeersReply(val myPushSha256: String?, val myAllow: List<String>, val peers: List<ListedPeer>)

/** The Worker calls the engines make (signed, PA-Time from the synced offset). */
interface Api {
    fun send(messages: Map<String, String>): ApiResult<Map<String, String>>
    fun approve(x: String, body: ByteArray): ApiResult<ApproveReply>
    fun deny(x: String, c: String): ApiResult<ApproveReply>
    fun withdraw(x: String): ApiResult<ApproveReply>
    fun pair(x: String, kind: String, c: String): ApiResult<String>
    fun peers(): ApiResult<PeersReply>
    fun pause(messages: Map<String, String>): ApiResult<Map<String, String>>
    fun unpause(ticket: String, messages: Map<String, String>): ApiResult<Map<String, String>>
    fun rename(names: Map<String, String>, messages: Map<String, String>): ApiResult<Map<String, String>>
    fun deletePeer(id: String, messages: Map<String, String>): ApiResult<Map<String, String>>

    companion object {
        /** POST /approve body, serialized once; the same bytes are re-sent while waiting. */
        fun approveBody(c: String, name: String): ByteArray =
            "{\"c\":${com.pusharmor.protocol.StrictJson.quote(c)},\"name\":${com.pusharmor.protocol.StrictJson.quote(name)}}".toByteArray(Charsets.UTF_8)
    }
}
