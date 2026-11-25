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
    /** A decrypt failed for another reason than memory: the blob stays for a tap on Decrypt; never retried by itself. */
    val decryptError: Boolean = false,
)

/**
 * Received files in app-private storage, one folder per file key: "blob" (the ciphertext, resumed by Range),
 * "plain.tmp" (a decrypt in progress), "state", "manual" (a tap on Download not yet run), and the folder "out"
 * that holds only the decrypted file under its sanitized name, so no name can meet an internal file.
 * Work on one file runs under its lock ([locked]), so two runs never write the same blob or state.
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
        private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()
    }

    /** Runs [block] holding the lock of file [key] (one lock per file in this process). */
    fun <T> locked(key: String, block: () -> T): T = synchronized(locks.getOrPut(File(root, key).absolutePath) { Any() }) { block() }

    /** The folder of the decrypted file. */
    fun outDir(key: String) = File(dir(key), "out")

    /** Records a tap on Download: the next run is manual (one GET even after expires; the automatic count starts again). */
    fun markManual(key: String) { dir(key).mkdirs(); File(dir(key), "manual").createNewFile() }

    /** Takes a tap recorded by [markManual] in one step: true when there was one, and it is gone. */
    fun takeManual(key: String): Boolean = File(dir(key), "manual").delete()

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
            p.getProperty("decryptError") == "1",
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
        if (s.decryptError) p["decryptError"] = "1"
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
    fun reviewMarks(lowMemoryExits: () -> List<Long>, before: Long = now()) {
        // only marks set before this process started: a decrypt of this process may have set a newer one
        val marked = keys().filter { state(it).markAt in 1 until before }
        if (marked.isEmpty()) return
        val exits = lowMemoryExits()
        for (k in marked) locked(k) {
            val s = state(k)
            if (s.markAt in 1 until before) {
                File(dir(k), TMP).delete()
                put(k, s.copy(markAt = 0, memoryError = s.memoryError || FileRules.markShowsMemoryError(s.markAt, exits)))
            }
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
     * ([cancelled] is checked between reads; it throws [CancellationException]). [onBytes] gets the blob bytes read so far.
     */
    fun decrypt(key: String, f: FileValue, name: String, manual: Boolean, heapFree: () -> Long, onBytes: (Long) -> Unit = {}, cancelled: () -> Boolean = { false }): Decrypted =
        locked(key) { decryptLocked(key, f, name, manual, heapFree, onBytes, cancelled) }

    private fun decryptLocked(key: String, f: FileValue, name: String, manual: Boolean, heapFree: () -> Long, onBytes: (Long) -> Unit, cancelled: () -> Boolean): Decrypted {
        var s = state(key)
        check(s.downloaded) { "not downloaded" }
        if (!manual && s.memoryError) return Decrypted.NoMemory // never retried by itself
        if (!manual && heapFree() < FileCrypt.WORKING_MEMORY) return Decrypted.NoMemory.also { put(key, s.copy(memoryError = true)) }
        s = s.copy(markAt = now(), memoryError = false, decryptError = false)
        put(key, s)
        val d = dir(key)
        val tmp = File(d, TMP)
        val ok = try {
            blob(key).inputStream().use { input ->
                FileOutputStream(tmp).use { out -> FileCrypt.open(B64url.decode(f.key), Cancellable(input, cancelled, onBytes), out).also { if (it) out.fd.sync() } }
            }
        } catch (e: OutOfMemoryError) {
            tmp.delete()
            put(key, s.copy(markAt = 0, memoryError = true))
            return Decrypted.NoMemory
        } catch (e: Throwable) {
            // a cancel, a full disk, or any other failure: an orderly end clears the mark and the temp file
            tmp.delete()
            put(key, s.copy(markAt = 0))
            if (e is IOException && (freeBytes() ?: Long.MAX_VALUE) < f.size) return final(key, FinalCode.STORAGE, FileRules.storageFullText(false, name))
            throw e
        }
        if (!ok) {
            tmp.delete()
            blob(key).delete()
            if (s.redownloaded) return final(key, FinalCode.DAMAGED, FileRules.FILE_DAMAGED)
            put(key, s.copy(markAt = 0, downloaded = false, redownloaded = true, attempts = Attempts()))
            return Decrypted.Redownload
        }
        val outDir = outDir(key).also { it.mkdirs() }
        val out = File(outDir, name)
        if (out.canonicalFile.parentFile != outDir.canonicalFile || !tmp.renameTo(out)) { tmp.delete(); put(key, s.copy(markAt = 0)); throw IOException("rename") }
        blob(key).delete()
        put(key, s.copy(markAt = 0, plain = name))
        return Decrypted.Ok(out)
    }

    /**
     * Keeps the copy of a sent file for History row [key] as a finished download leaves it: [size] bytes of
     * [input] are streamed into the temp file and moved into place under [name]. The storage check and the
     * storage-full row error are those of a download (false); any other failure keeps nothing and throws.
     */
    fun keepSent(key: String, input: InputStream, size: Long, name: String): Boolean = locked(key) {
        val full = { put(key, FileState(code = FinalCode.STORAGE, text = FileRules.storageFullText(false, name))); false }
        if (!FileRules.enoughStorage(freeBytes(), size)) return@locked full()
        val tmp = File(dir(key).also { it.mkdirs() }, TMP)
        try {
            FileOutputStream(tmp).use { out -> if (input.copyTo(out) != size) throw FileChangedException(); out.fd.sync() }
            val outDir = outDir(key).also { it.mkdirs() }
            val out = File(outDir, name)
            if (out.canonicalFile.parentFile != outDir.canonicalFile || !tmp.renameTo(out)) throw IOException("rename")
            put(key, FileState(downloaded = true, plain = name))
            true
        } catch (e: Throwable) {
            delete(key)
            if (e is IOException && e !is FileChangedException && (freeBytes() ?: Long.MAX_VALUE) < size) return@locked full()
            throw e
        }
    }

    private fun final(key: String, code: FinalCode, text: String): Decrypted.Final {
        put(key, state(key).copy(markAt = 0, code = code, text = text))
        return Decrypted.Final(code, text)
    }

    private class Cancellable(private val inner: InputStream, private val cancelled: () -> Boolean, private val onBytes: (Long) -> Unit) : InputStream() {
        private var read = 0L
        override fun read(): Int = throw UnsupportedOperationException()
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (cancelled()) throw CancellationException("decrypt cancelled")
            return inner.read(b, off, len).also { if (it > 0) { read += it; onBytes(read) } }
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
        } catch (e: Throwable) {
            out.delete()
            if (e is IOException && e !is FileChangedException && (usableSpace(tempDir).takeIf { it > 0 } ?: Long.MAX_VALUE) < size + FileCrypt.BLOB_OVERHEAD) throw FileError(FinalCode.STORAGE, FileRules.storageFullText(true, name))
            throw e
        }
    }
}
