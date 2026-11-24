package com.pusharmor.app.files

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.FileChangedException
import com.pusharmor.crypto.FileCrypt
import com.pusharmor.net.FileError
import com.pusharmor.protocol.FileRules
import com.pusharmor.protocol.FileRules.Attempts
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Properties
import java.util.concurrent.CancellationException

/**
 * What this device knows of one received file: automatic attempts, the one re-download, the outcome, and the
 * decrypt-attempted mark ([markAt], ms; 0 = none).
 */
data class FileState(
    val attempts: Attempts = Attempts(),
    val redownloaded: Boolean = false,
    /** The whole blob is stored and its size and sha256 matched. */
    val downloaded: Boolean = false,
    val code: FinalCode? = null,
    val text: String? = null,
    val markAt: Long = 0,
    /** "Not enough memory to decrypt": an attempt ran short of memory or closed the app; never retried by itself. */
    val memoryError: Boolean = false,
    /** Name of the decrypted file, once it is in place. */
    val plain: String? = null,
)

/**
 * Received files in app-private storage, one folder per file key: "blob" (the ciphertext, resumed by Range),
 * "plain.tmp" (a decrypt in progress), "state", and the decrypted file under its sanitized name.
 */
class FileStore(
    val root: File,
    private val now: () -> Long = System::currentTimeMillis,
    /** Free bytes on the storage that holds [root]; 0 = unknown. */
    private val usableSpace: (File) -> Long = File::getUsableSpace,
) {
    companion object {
        private val KEY = Regex("[A-Za-z0-9_-]{1,64}")
        private const val TMP = "plain.tmp"
        fun validKey(key: String) = KEY.matches(key)
    }

    fun dir(key: String): File {
        require(validKey(key)) { "bad file key" }
        return File(root, key)
    }

    fun blob(key: String) = File(dir(key), "blob")

    /** Keys of every stored file. */
    fun keys(): List<String> = root.listFiles()?.filter { it.isDirectory && validKey(it.name) }?.map { it.name } ?: emptyList()

    fun state(key: String): FileState {
        val f = File(dir(key), "state")
        if (!f.isFile) return FileState()
        val p = Properties()
        try { f.inputStream().use { p.load(it) } } catch (e: IOException) { return FileState() }
        fun long(k: String, d: Long) = p.getProperty(k)?.toLongOrNull() ?: d
        return FileState(
            Attempts(long("used", 0).toInt(), long("openAt", -1)),
            p.getProperty("redownloaded") == "1",
            p.getProperty("downloaded") == "1",
            p.getProperty("code")?.let { c -> FinalCode.entries.firstOrNull { it.name == c } },
            p.getProperty("text"),
            long("markAt", 0),
            p.getProperty("memoryError") == "1",
            p.getProperty("plain"),
        )
    }

    /** Written to a temp file and renamed, so a killed process leaves the old or the new state. */
    fun put(key: String, s: FileState) {
        val d = dir(key).also { it.mkdirs() }
        val p = Properties()
        p["used"] = s.attempts.used.toString()
        p["openAt"] = s.attempts.openAt.toString()
        if (s.redownloaded) p["redownloaded"] = "1"
        if (s.downloaded) p["downloaded"] = "1"
        s.code?.let { p["code"] = it.name }
        s.text?.let { p["text"] = it }
        p["markAt"] = s.markAt.toString()
        if (s.memoryError) p["memoryError"] = "1"
        s.plain?.let { p["plain"] = it }
        val tmp = File(d, "state.tmp")
        FileOutputStream(tmp).use { p.store(it, null); it.fd.sync() }
        if (!tmp.renameTo(File(d, "state"))) throw IOException("state rename")
    }

    fun delete(key: String) { dir(key).deleteRecursively() }

    /** Free bytes on the storage that holds the files; null when unknown. */
    fun freeBytes(): Long? = usableSpace(root.also { it.mkdirs() }).takeIf { it > 0 }

    /**
     * At app start: every decrypt-attempted mark left behind means the app closed during a decrypt. With a
     * low-memory exit after the mark the file shows the memory error (never retried by itself); else the mark is
     * cleared. Any half-written plaintext is deleted. [lowMemoryExits]: times (ms) of low-memory exits.
     */
    fun reviewMarks(lowMemoryExits: () -> List<Long>) {
        val marked = keys().filter { state(it).markAt > 0 }
        if (marked.isEmpty()) return
        val exits = lowMemoryExits()
        for (k in marked) {
            File(dir(k), TMP).delete()
            val s = state(k)
            put(k, s.copy(markAt = 0, memoryError = s.memoryError || FileRules.markShowsMemoryError(s.markAt, exits)))
        }
    }

    sealed class Decrypted {
        data class Ok(val file: File) : Decrypted()
        /** Short of memory, before or during the decrypt: row error and a Decrypt button. */
        object NoMemory : Decrypted()
        /** The tag failed: the blob was dropped for one re-download. */
        object Redownload : Decrypted()
        /** A final error (damaged after the re-download, or storage full); also kept in the state. */
        data class Final(val code: FinalCode, val text: String) : Decrypted()
    }

    /**
     * Decrypts the downloaded blob of [key] into a private temp file, moved into place under [name] only after the
     * tag passes. [manual] (the Decrypt button) skips the free-memory check. [heapFree]: bytes the heap can still
     * grow by. The decrypt-attempted mark is set first and cleared on every orderly end, including a cancel
     * ([cancelled] is checked between reads; it throws [CancellationException]).
     */
    fun decrypt(key: String, f: FileValue, name: String, manual: Boolean, heapFree: () -> Long, cancelled: () -> Boolean = { false }): Decrypted {
        var s = state(key)
        check(s.downloaded) { "not downloaded" }
        if (!manual && s.memoryError) return Decrypted.NoMemory // never retried by itself
        if (!manual && heapFree() < FileCrypt.WORKING_MEMORY) return Decrypted.NoMemory.also { put(key, s.copy(memoryError = true)) }
        s = s.copy(markAt = now(), memoryError = false)
        put(key, s)
        val d = dir(key)
        val tmp = File(d, TMP)
        val ok = try {
            blob(key).inputStream().use { input ->
                FileOutputStream(tmp).use { out -> FileCrypt.open(B64url.decode(f.key), Cancellable(input, cancelled), out).also { if (it) out.fd.sync() } }
            }
        } catch (e: OutOfMemoryError) {
            tmp.delete()
            put(key, s.copy(markAt = 0, memoryError = true))
            return Decrypted.NoMemory
        } catch (e: CancellationException) {
            tmp.delete()
            put(key, s.copy(markAt = 0))
            throw e
        } catch (e: IOException) {
            tmp.delete()
            put(key, s.copy(markAt = 0))
            if ((freeBytes() ?: Long.MAX_VALUE) < f.size) return final(key, FinalCode.STORAGE, FileRules.storageFullText(false, name))
            throw e
        }
        if (!ok) {
            tmp.delete()
            blob(key).delete()
            if (s.redownloaded) return final(key, FinalCode.DAMAGED, FileRules.FILE_DAMAGED)
            put(key, s.copy(markAt = 0, downloaded = false, redownloaded = true, attempts = Attempts()))
            return Decrypted.Redownload
        }
        val out = File(d, name)
        if (!tmp.renameTo(out)) { tmp.delete(); put(key, s.copy(markAt = 0)); throw IOException("rename") }
        blob(key).delete()
        put(key, s.copy(markAt = 0, plain = name))
        return Decrypted.Ok(out)
    }

    private fun final(key: String, code: FinalCode, text: String): Decrypted.Final {
        put(key, state(key).copy(markAt = 0, code = code, text = text))
        return Decrypted.Final(code, text)
    }

    private class Cancellable(private val inner: InputStream, private val cancelled: () -> Boolean) : InputStream() {
        override fun read(): Int = throw UnsupportedOperationException()
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (cancelled()) throw CancellationException("decrypt cancelled")
            return inner.read(b, off, len)
        }
    }

    /** A sealed file ready to upload: the blob in a private temp file, its key and sha256. Delete [blob] once the send is done. */
    class Sealed(val blob: File, val key: ByteArray, val sha256: String)

    /**
     * Seals [size] bytes of [input] into a temp file in [tempDir] for an upload. A full disk throws [FileError]
     * with 'Not enough storage to send "name"'; [FileChangedException] when the input held another size.
     */
    fun seal(tempDir: File, input: InputStream, size: Long, name: String): Sealed {
        if (size > FileCrypt.MAX_FILE) throw FileError(FinalCode.TOO_LARGE, null)
        tempDir.mkdirs()
        val out = File.createTempFile("send-", ".blob", tempDir)
        val key = FileCrypt.newKey()
        try {
            val sha = FileOutputStream(out).use { FileCrypt.seal(key, input, size, it) }
            return Sealed(out, key, sha)
        } catch (e: FileChangedException) {
            out.delete()
            throw e
        } catch (e: IOException) {
            out.delete()
            if ((usableSpace(tempDir).takeIf { it > 0 } ?: Long.MAX_VALUE) < size + FileCrypt.BLOB_OVERHEAD) throw FileError(FinalCode.STORAGE, FileRules.storageFullText(true, name))
            throw e
        }
    }
}
