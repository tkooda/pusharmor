package com.pusharmor.protocol

import com.pusharmor.crypto.FileCrypt

/**
 * File transfer rules: the auto-download decision, the upload and download status table, the free-storage
 * check, and the count of automatic download attempts. Pure functions only.
 */
object FileRules {
    /** Auto-download picker limits in bytes: Off, Up to 10 MB, 25 MB, 50 MB, 100 MB. */
    val PICKER_SIZES = longArrayOf(0, 10_000_000, 25_000_000, 50_000_000, 100_000_000)
    const val DEFAULT_PICKER = 50_000_000L

    /** Bytes kept free beyond 2 x the file size before a download starts. */
    const val FREE_MARGIN = 10_000_000L

    /** Automatic download attempts per file. */
    const val DOWNLOAD_TRIES = 5

    /** An upload and at most 2 automatic retries of the same send. */
    const val UPLOAD_TRIES = 3

    const val FILE_PAUSED = "File sending is paused. Try again later"
    const val FILE_DAMAGED = "Unable to open this file. It is not valid or was damaged."
    const val DOWNLOAD_FAILED = "Download failed"

    /** The network a phone is on: [WIFI] is any unmetered network, [MOBILE] any metered one. */
    enum class Network { WIFI, MOBILE }

    /** The picker that applies on [network]; Data Saver turns the mobile picker Off. */
    fun pickerFor(network: Network, wifi: Long, mobile: Long, dataSaver: Boolean): Long =
        if (network == Network.WIFI) wifi else if (dataSaver) 0 else mobile

    /** true when the picker (bytes, 0 = Off) lets a file of this size download by itself. */
    fun autoDownload(picker: Long, size: Long): Boolean = picker > 0 && size <= picker && size <= FileCrypt.MAX_FILE

    /** Catch-up (app open, open from a notification, network change): a pending file starts by itself only before it expires by the local clock. */
    fun catchUpDue(size: Long, expires: Long, picker: Long, localNowSec: Long): Boolean = localNowSec < expires && autoDownload(picker, size)

    /** [free]: bytes free on the device's storage; null = unknown (no check). */
    fun enoughStorage(free: Long?, size: Long): Boolean = free == null || free >= 2 * size + FREE_MARGIN

    fun storageFullText(upload: Boolean, name: String): String = "Not enough storage to " + (if (upload) "send" else "download") + " \"" + FileName.cut(name) + "\""

    enum class FinalCode {
        QUOTA, // 429 file quota
        PAUSED, // 503 files paused
        EXPIRED,
        DELETED,
        UPDATE, // 404 update required, or 426
        TOO_LARGE, // 413
        STORAGE, // not enough storage on this device
        DAMAGED, // sha256, size, or tag failed twice, or a bad file URL
        FAILED, // any other refusal, or the automatic tries are used up
    }

    sealed class Outcome {
        /** Try again; [wait] is the reply's retry_after in seconds, else null. */
        data class Retry(val wait: Long?) : Outcome()
        /** No automatic retry; [text] is the row or toast text, null where the caller words it. */
        data class Final(val code: FinalCode, val text: String?) : Outcome()
    }

    /** Seconds, rounded up -> "N minutes" under 1 hour, "N hours" under 2 days, else "N days" (3599 s -> "1 hour"). */
    fun fileWait(s: Long): String {
        fun plural(n: Long, unit: String) = "$n $unit" + if (n == 1L) "" else "s"
        val m = maxOf(1, (s + 59) / 60)
        if (m < 60) return plural(m, "minute")
        val h = (s + 3599) / 3600
        return if (h < 48) plural(h, "hour") else plural((s + 86399) / 86400, "day")
    }

    /**
     * The status table for POST /v1/file and the file GET. [status] 0 = no reply; [error] and [retryAfter]
     * (seconds, null when absent or not a positive integer) come from the JSON reply.
     * Download only: [nowSec] is the corrected clock (local + PA-Epoch offset) and [expires] the file's expires,
     * so a 404 reads "Deleted" before expires and "Expired" at or after it.
     */
    fun fileStatus(upload: Boolean, status: Int, error: String?, retryAfter: Long?, nowSec: Long = 0, expires: Long = 0): Outcome {
        val ra = retryAfter?.takeIf { it > 0 }
        fun final(code: FinalCode, text: String? = null) = Outcome.Final(code, text)
        if (status == 429 && error == "file quota") return final(FinalCode.QUOTA, "You reached your file limit. Try again " + (if (ra != null) "in " + fileWait(ra) else "later"))
        if (status == 503 && error == "files paused") return final(FinalCode.PAUSED, if (ra != null) "File sending is over quota and paused for " + fileWait(ra) else FILE_PAUSED)
        if (status == 0 || status == 429 || status in 500..599) return Outcome.Retry(ra)
        if (status == 426) return final(FinalCode.UPDATE)
        if (upload) return if (status == 413) final(FinalCode.TOO_LARGE) else final(FinalCode.FAILED)
        if (status == 410) return final(FinalCode.EXPIRED, "Expired")
        if (status == 404 && error == "update required") return final(FinalCode.UPDATE, "Update the app")
        if (status == 404) return if (nowSec < expires) final(FinalCode.DELETED, "Deleted") else final(FinalCode.EXPIRED, "Expired")
        return final(FinalCode.FAILED, DOWNLOAD_FAILED)
    }

    /**
     * Automatic download attempts of one file, kept across job runs. [used]: attempts counted; [openAt]: bytes
     * stored when the current run started, -1 when no run is open. A run is counted when it starts, so a killed
     * process cannot lose the count; a run that the system stopped after it gained bytes is not counted.
     */
    data class Attempts(val used: Int = 0, val openAt: Long = -1) {
        /** A run starts with [have] bytes stored. null: the automatic attempts are used up. */
        fun start(have: Long): Attempts? {
            val u = settled(have)
            return if (u >= DOWNLOAD_TRIES) null else Attempts(u + 1, have)
        }

        /** The run ended by itself (done, a final error, or an error to retry): it counts. */
        fun end(): Attempts = Attempts(used, -1)

        /** The system stopped the run with [have] bytes stored: it counts only when it gained no bytes. */
        fun stopped(have: Long): Attempts = Attempts(settled(have), -1)

        /** [used] after an open run (a stop, or a process that was killed) that gained bytes is taken back. */
        private fun settled(have: Long): Int = if (openAt >= 0 && have > openAt) used - 1 else used
    }

    /** The decrypt-attempted mark of a file met at app start: true = show the memory error (the app closed for low memory after the mark); false = clear the mark. */
    fun markShowsMemoryError(markAtMs: Long, lowMemoryExitsMs: List<Long>): Boolean = lowMemoryExitsMs.any { it >= markAtMs }
}
