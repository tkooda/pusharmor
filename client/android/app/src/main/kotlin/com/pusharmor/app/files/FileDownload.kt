package com.pusharmor.app.files

import com.pusharmor.crypto.FileCrypt
import com.pusharmor.net.FileClient.Fetch
import com.pusharmor.net.FileError
import com.pusharmor.protocol.FileRules
import com.pusharmor.protocol.FileRules.Attempts
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import java.io.File

/**
 * One run of the download job of a received file. The job checks file.expires at each start (WorkManager has
 * no deadline), counts automatic attempts across runs (at most [FileRules.DOWNLOAD_TRIES]; a system stop that
 * gained bytes does not count), checks free space (2 x size + margin), resumes the blob with Range, and checks
 * size and sha256 right after the last byte, with one re-download on a mismatch.
 */
class FileDownload(
    private val store: FileStore,
    /** One GET into the blob file (FileClient.fetch). */
    private val fetch: (FileValue, String, File, () -> Boolean) -> Fetch,
    /** Local clock, Unix seconds. */
    private val nowSec: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    sealed class Run {
        /** The blob is stored and checked; decrypt next. */
        object Done : Run()
        /** Try again later (counted). [wait]: retry_after in seconds, else null. */
        data class Retry(val wait: Long?) : Run()
        /** The system stopped the run; bytes that arrived are kept. */
        object Stopped : Run()
        /** No automatic retry; [text] is the row text (null where the caller words it). */
        data class Final(val code: FinalCode, val text: String?) : Run()
    }

    /** [name]: the sanitized name; [manual]: a tap on Download (one GET even after expires; the automatic count starts again). */
    fun run(key: String, f: FileValue, name: String, manual: Boolean, stopped: () -> Boolean = { false }): Run {
        var s = store.state(key)
        if (s.downloaded) return Run.Done
        if (manual) s = s.copy(attempts = Attempts(), redownloaded = false, code = null, text = null)
        else {
            if (s.code != null) return Run.Final(s.code!!, s.text)
            if (nowSec() >= f.expires) return final(key, s, FinalCode.EXPIRED, "Expired")
        }
        val blob = store.blob(key)
        val next = s.attempts.start(blob.length()) ?: return final(key, s, FinalCode.FAILED, FileRules.DOWNLOAD_FAILED)
        s = s.copy(attempts = next)
        store.put(key, s)
        if (!FileRules.enoughStorage(store.freeBytes(), f.size)) return final(key, s, FinalCode.STORAGE, FileRules.storageFullText(false, name))
        try {
            while (true) {
                val r = fetch(f, name, blob, stopped)
                if (r == Fetch.Stopped) {
                    store.put(key, s.copy(attempts = s.attempts.stopped(blob.length())))
                    return Run.Stopped
                }
                if (r is Fetch.Retry) {
                    store.put(key, s.copy(attempts = s.attempts.end()))
                    return Run.Retry(r.wait)
                }
                if (r == Fetch.Done && blob.length() == f.size + FileCrypt.BLOB_OVERHEAD && blob.inputStream().use { FileCrypt.sha256(it) } == f.sha256) {
                    store.put(key, s.copy(attempts = s.attempts.end(), downloaded = true))
                    return Run.Done
                }
                // damaged: one re-download, then final
                blob.delete()
                if (s.redownloaded) return final(key, s, FinalCode.DAMAGED, FileRules.FILE_DAMAGED)
                s = s.copy(redownloaded = true)
                store.put(key, s)
            }
        } catch (e: FileError) {
            return final(key, s, e.code, e.text)
        }
    }

    /** A final outcome keeps no partial blob. */
    private fun final(key: String, s: FileState, code: FinalCode, text: String?): Run.Final {
        store.blob(key).delete()
        store.put(key, s.copy(attempts = s.attempts.end(), code = code, text = text))
        return Run.Final(code, text)
    }
}
