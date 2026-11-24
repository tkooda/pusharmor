package com.pusharmor.app.files

import android.content.Context
import android.net.ConnectivityManager
import android.os.StatFs
import androidx.work.WorkManager
import com.pusharmor.app.data.Settings
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import com.pusharmor.protocol.InnerMessage
import com.pusharmor.protocol.StrictJson
import com.pusharmor.store.HistoryEntity
import com.pusharmor.store.PaDao

/**
 * Received files of this device: the download job a file gets on arrival and on catch-up (app open, open from a
 * notification; a job that waits for Wi-Fi gives the unmetered catch-up, with no polling), the storage limit, and
 * the wipe at logout. The file key is the History row id.
 */
class ReceivedFiles(
    private val context: Context,
    private val settings: Settings,
    private val dao: PaDao,
    val store: FileStore,
    private val enqueue: (key: String, f: FileValue, name: String, unmeteredOnly: Boolean, manual: Boolean) -> Unit =
        { key, f, name, u, manual -> FileWork.download(context, store, key, f, name, u, manual) },
    private val cancel: (key: String) -> Unit = { key -> WorkManager.getInstance(context).cancelUniqueWork("file-$key") },
    private val nowSec: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    companion object {
        fun key(historyId: Long) = historyId.toString()
        fun fileOf(h: HistoryEntity): FileValue? = if (h.type != "file") null else h.content?.let { InnerMessage.fileValueOf(StrictJson.parseOrNull(it)) }
    }

    fun wifiPicker(): Long = FileUi.picker(settings.get(Settings.K.FILE_WIFI))
    fun mobilePicker(): Long = FileUi.picker(settings.get(Settings.K.FILE_MOBILE))

    private fun cm() = context.getSystemService(ConnectivityManager::class.java)

    /** Data Saver is on for this app. */
    fun dataSaver(): Boolean = cm()?.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED

    /** true on a metered network, false on an unmetered one, null with no network. */
    fun metered(): Boolean? = cm()?.let { if (it.activeNetwork == null) null else it.isActiveNetworkMetered }

    /** Queues the automatic download of one received file when the pickers allow it and it has not expired. */
    private fun autoQueue(historyId: Long, at: Long, f: FileValue) {
        val a = FileUi.autoNow(f.size, f.expires, nowSec(), wifiPicker(), mobilePicker(), dataSaver(), metered()) ?: return
        enqueue(key(historyId), f, FileUi.receivedName(f.name, at), a == FileUi.Auto.UNMETERED, false)
    }

    /** A file just arrived (its row is written). */
    fun onArrived(historyId: Long, f: FileValue) {
        val h = dao.history(historyId) ?: return
        autoQueue(historyId, h.at, f)
    }

    /**
     * Catch-up: every received file that is not downloaded, has no final outcome, and has not expired gets its job
     * again (a queued job is kept). Files whose row is gone are dropped.
     */
    fun catchUp() {
        val rows = dao.fileRows()
        sweep(rows.map { key(it.id) }.toSet())
        for (h in rows) {
            if (h.direction != "RECEIVED") continue
            val f = fileOf(h) ?: continue
            val s = store.state(key(h.id))
            if (s.downloaded || s.code != null || s.memoryError || s.plain != null) continue
            autoQueue(h.id, h.at, f)
        }
    }

    /** A tap on Download: one GET at once on any network, even after expires. */
    fun download(h: HistoryEntity) {
        val f = fileOf(h) ?: return
        enqueue(key(h.id), f, FileUi.receivedName(f.name, h.at), false, true)
    }

    /** The decrypt found a damaged blob: the one re-download runs by itself. */
    fun redownload(h: HistoryEntity) {
        val f = fileOf(h) ?: return
        enqueue(key(h.id), f, FileUi.receivedName(f.name, h.at), false, false)
    }

    /** Rows deleted here: their files and jobs go too. */
    fun forget(historyIds: Collection<Long>) {
        for (id in historyIds) { cancel(key(id)); store.delete(key(id)) }
    }

    /** Drops stored files whose row is gone. */
    private fun sweep(keep: Set<String>) {
        for (k in store.keys()) if (k !in keep) { cancel(k); store.delete(k) }
    }

    /** Bytes a stored file holds: the blob and the decrypted file. */
    private fun bytes(key: String): Long = store.blob(key).length() + (store.outDir(key).listFiles()?.sumOf { it.length() } ?: 0)

    /** Total bytes of the storage that holds the files. */
    fun totalBytes(): Long = try { StatFs(store.root.also { it.mkdirs() }.path).totalBytes } catch (e: Exception) { Long.MAX_VALUE }

    fun storageLimit(): Long = FileUi.storageLimit(settings.get(Settings.K.FILE_STORAGE), totalBytes())

    /** Removes the oldest files until the rest fit the storage limit; their rows say "Removed from this device". */
    fun enforceLimit() {
        val at = dao.fileRows().associate { key(it.id) to it.at }
        val stored = store.keys().map { FileUi.Stored(it, at[it] ?: 0, bytes(it)) }
        for (k in FileUi.toRemove(stored, storageLimit())) store.locked(k) { removeLocked(k) }
    }

    private fun removeLocked(k: String) {
        cancel(k)
        val s = store.state(k)
        store.dir(k).deleteRecursively()
        store.put(k, FileState(attempts = s.attempts.end(), code = FinalCode.FAILED, text = FileUi.REMOVED))
    }

    /** Logout or removal of this device: every local file goes; the rows stay and say "Removed from this device". */
    fun wipe() {
        for (k in store.keys()) try { store.locked(k) { removeLocked(k) } } catch (e: Exception) { }
    }
}
