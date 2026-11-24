package com.pusharmor.app.ui

import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.pusharmor.app.Graph
import com.pusharmor.app.files.FileStore
import com.pusharmor.app.files.FileUi
import com.pusharmor.app.files.FileWork
import com.pusharmor.app.files.ReceivedFiles
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.FileChangedException
import com.pusharmor.crypto.FileCrypt
import com.pusharmor.net.ErrorText
import com.pusharmor.net.FileClient
import com.pusharmor.net.FileError
import com.pusharmor.protocol.FileName
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import com.pusharmor.protocol.engine.SendFlow
import com.pusharmor.store.HistoryEntity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

/**
 * The file parts of the app screens: the file chosen on the Send screen and its send, and the received file rows
 * of History (their state, the Download and Decrypt taps, and the decrypt, which runs only while History shows).
 */
class FileModel(private val g: Graph, private val scope: CoroutineScope, private val toast: (String) -> Unit) {
    /** A file chosen to send: [name] as the picker gave it (an extension added from its type when it had none). */
    data class Chosen(val uri: String, val name: String, val size: Long)

    val chosen = MutableStateFlow<Chosen?>(null)

    /** Reads the name and size of a picked or shared file; a file over the cap or one that cannot be read gives a toast instead. */
    fun choose(uri: Uri): Job = scope.launch(Dispatchers.IO) {
        val cr = g.app.contentResolver
        var name = "file"
        var size = -1L
        try {
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
            if (FileName.splitExt(name).second.isEmpty()) cr.getType(uri)?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }?.let { name = "$name.$it" }
            // no size given: count the bytes, up to one past the cap
            if (size < 0) size = cr.openInputStream(uri)?.use { s -> var n = 0L; val b = ByteArray(65536); while (n <= FileCrypt.MAX_FILE) { val r = s.read(b); if (r < 0) break; n += r }; n } ?: -1
        } catch (e: Exception) {
            Log.w("PushArmor", "file pick", e)
            size = -1
        }
        when {
            size < 0 -> toast(FileUi.unreadable(name))
            size > FileCrypt.MAX_FILE -> toast(FileUi.tooLarge(name))
            else -> chosen.value = Chosen(uri.toString(), name, size)
        }
    }

    /** The 201 of the last upload that was not sent on: a new tap on Send for the same file uses it again while it has not expired. */
    private class Prior(val uri: String, val size: Long, val value: FileValue)
    @Volatile private var prior: Prior? = null

    /** Seals and uploads [c] (or uses the last upload of it again), then sends the file message. */
    fun sendFile(recipients: List<String>, c: Chosen, onStep: (Int) -> Unit): SendFlow.Outcome {
        val now = System.currentTimeMillis()
        val name = FileName.sanitize(c.name, now / 1000, FileUi.kind(c.name) == FileUi.Kind.IMAGE)
        val p = prior
        val value = if (p != null && p.uri == c.uri && p.size == c.size && g.fileClient.nowSec() < p.value.expires) p.value else {
            val input = g.app.contentResolver.openInputStream(Uri.parse(c.uri)) ?: throw FileChangedException()
            val sealed = input.use { g.fileStore.seal(File(g.app.cacheDir, "send"), it, c.size, name) }
            onStep(10)
            val length = sealed.blob.length()
            val reply = try { g.fileClient.upload(sealed.blob, sealed.sha256, FileClient.newSendId()) { onStep(FileUi.uploadStep(it, length)) } } finally { sealed.blob.delete() }
            FileValue(reply.url, reply.expires, B64url.encode(sealed.key), name, c.size, sealed.sha256).also { prior = Prior(c.uri, c.size, it) }
        }
        val out = g.sender().sendFile(recipients, value, now, onStep)
        if (out.error == null) { prior = null; chosen.value = null }
        return out
    }

    /** The error text of a failed file send; null when the caller words it. */
    fun sendError(e: Throwable, c: Chosen): String? = when (e) {
        is FileError -> when {
            e.code == FinalCode.STORAGE && e.text != null -> e.text
            e.code == FinalCode.TOO_LARGE -> FileUi.tooLarge(c.name)
            e.text != null -> ErrorText.text(UiText.UNABLE_SEND, e.text!!)
            e.code == FinalCode.UPDATE -> ErrorText.text(UiText.UNABLE_SEND, ErrorText.UPDATE)
            e.status == 0 -> ErrorText.text(UiText.UNABLE_SEND, ErrorText.UNREACHABLE)
            e.status >= 500 -> ErrorText.text(UiText.UNABLE_SEND, ErrorText.SERVER_DOWN)
            else -> ErrorText.text(UiText.UNABLE_SEND, ErrorText.REFUSED)
        }
        is FileChangedException -> FileUi.unreadable(c.name)
        else -> null
    }

    // ---- received file rows ----

    /** What one file row shows; [plain] is the decrypted file, [image] true when it decodes as an image. */
    data class Row(val status: FileUi.Status, val plain: File? = null, val image: Boolean = false, val name: String = "")

    val rows = MutableStateFlow<Map<Long, Row>>(emptyMap())
    @Volatile private var runningKeys: Set<String> = emptySet()
    private val images = HashMap<String, Boolean>()

    private var watching: Job? = null

    /** Follows the download jobs while History is open (each change reads the rows again). */
    fun watch() {
        if (watching?.isActive == true) return
        watching = scope.launch {
            try {
                WorkManager.getInstance(g.app).getWorkInfosByTagFlow(FileWork.TAG).collect { infos ->
                    runningKeys = infos.filter { it.state == WorkInfo.State.RUNNING }.flatMap { it.tags }.filter { it.startsWith(FileWork.TAG + ":") }.map { it.substringAfter(':') }.toSet()
                    refresh()
                }
            } catch (e: CancellationException) { throw e } catch (e: Exception) { Log.w("PushArmor", "file jobs", e) }
        }
    }

    /** Reads the state of every file row again; then starts the decrypts that are due. */
    fun refresh(decrypt: Boolean = true): Job = scope.launch(Dispatchers.IO) {
        val now = System.currentTimeMillis() / 1000
        val out = HashMap<Long, Row>()
        for (h in g.dao.fileRows()) {
            if (h.direction != "RECEIVED") continue
            val f = ReceivedFiles.fileOf(h) ?: continue
            val k = ReceivedFiles.key(h.id)
            val s = g.fileStore.state(k)
            val plain = s.plain?.let { File(g.fileStore.outDir(k), it) }?.takeIf { it.isFile }
            val st = FileUi.status(s, k in runningKeys, g.fileStore.blob(k).length(), plain != null, f.size, f.expires, now)
            val image = plain != null && synchronized(images) { images.getOrPut(k) { decodes(plain) } }
            out[h.id] = Row(st, plain, image, FileUi.receivedName(f.name, h.at))
        }
        rows.value = out
        if (decrypt && shown) decryptDue()
    }

    /** true when the file's bytes decode as an image (the declared type is never trusted). */
    private fun decodes(f: File): Boolean = try {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, o)
        o.outWidth > 0 && o.outHeight > 0
    } catch (e: Exception) { false }

    /** History is showing (true) or not: decrypts run only while it shows, and stop when it goes. */
    @Volatile var shown = false
        private set

    fun setShown(on: Boolean) {
        if (on == shown) return
        shown = on
        if (!on) return
        scope.launch(Dispatchers.IO) { try { g.files.catchUp() } catch (e: Exception) { } }
        watch()
        refresh()
        // the progress of a running download: local file sizes, read once a second while History shows
        scope.launch {
            while (shown) {
                delay(1000)
                if (runningKeys.isNotEmpty()) refresh(decrypt = false)
            }
        }
    }

    private val decrypting = Mutex()

    /** Decrypts, one at a time, every downloaded file that is due; a file short of memory waits for a tap on Decrypt. */
    private fun decryptDue(): Job = scope.launch(Dispatchers.IO) {
        if (decrypting.isLocked) return@launch
        decrypting.withLock {
            for (h in g.dao.fileRows()) {
                if (!shown) break
                if (h.direction != "RECEIVED") continue
                val s = g.fileStore.state(ReceivedFiles.key(h.id))
                if (!s.downloaded || s.plain != null || s.code != null || s.memoryError || s.decryptError || s.markAt != 0L) continue
                decryptOne(h, manual = false)
            }
        }
        refreshQuiet()
    }

    /** The Decrypt button: skips the free-memory check and always tries. */
    fun decryptNow(id: Long): Job = scope.launch(Dispatchers.IO) {
        val h = g.dao.history(id) ?: return@launch
        decrypting.withLock { decryptOne(h, manual = true) }
        refreshQuiet()
    }

    private fun decryptOne(h: HistoryEntity, manual: Boolean) {
        val f = ReceivedFiles.fileOf(h) ?: return
        val name = FileUi.receivedName(f.name, h.at)
        val r = try {
            g.fileStore.decrypt(ReceivedFiles.key(h.id), f, name, manual, FileWork::heapFree) { !shown }
        } catch (e: CancellationException) { return } catch (e: Exception) {
            // any other failure ends the decrypt with the row error and a Decrypt button; with no blob left, a Download button (a new download)
            Log.w("PushArmor", "decrypt", e)
            val k = ReceivedFiles.key(h.id)
            g.fileStore.locked(k) {
                if (g.fileStore.blob(k).isFile) g.fileStore.put(k, g.fileStore.state(k).copy(markAt = 0, decryptError = true))
                else g.fileStore.put(k, g.fileStore.state(k).copy(markAt = 0, downloaded = false, code = FinalCode.FAILED, text = com.pusharmor.protocol.FileRules.DOWNLOAD_FAILED))
            }
            return
        }
        when (r) {
            is FileStore.Decrypted.Ok -> g.files.enforceLimit()
            FileStore.Decrypted.NoMemory -> toast(FileUi.noMemoryToast(name))
            FileStore.Decrypted.Redownload -> g.files.redownload(h)
            is FileStore.Decrypted.Final -> {}
        }
    }

    private fun refreshQuiet(): Job = refresh(decrypt = false)

    /** A tap on Download. */
    fun download(id: Long): Job = scope.launch(Dispatchers.IO) {
        g.dao.history(id)?.let { g.files.download(it) }
        refresh()
    }

    /** Save: copies the decrypted file to the place the user chose, off the main thread; a toast says how it went. */
    fun save(file: File, to: Uri): Job = scope.launch(Dispatchers.IO) {
        val err = runCatching { g.app.contentResolver.openOutputStream(to)?.use { out -> file.inputStream().use { it.copyTo(out) } } ?: throw java.io.IOException("no stream") }.exceptionOrNull()
        toast(if (err == null) UiText.saved(file.name) else ErrorText.text(UiText.unableSave(file.name), UiText.saveReason(err)))
    }

    /** Rows deleted on this device: their files go too. */
    fun forget(ids: Collection<Long>) = g.files.forget(ids)
}
