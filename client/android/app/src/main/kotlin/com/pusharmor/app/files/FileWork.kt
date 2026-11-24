package com.pusharmor.app.files

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.pusharmor.app.PaApp
import com.pusharmor.protocol.FileValue
import com.pusharmor.protocol.InnerMessage
import com.pusharmor.protocol.StrictJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** One unique WorkManager job per received file; no foreground service: a job stopped by the system resumes by Range on its next run. */
object FileWork {
    /** Tag of every file download job; each also has "file:<key>". */
    const val TAG = "file"

    /**
     * [unmeteredOnly]: the picker allows the file on Wi-Fi only. [manual]: a tap on Download, recorded in the
     * file's folder first and run at once (a queued job is replaced; a run in progress is stopped, and the new
     * run waits for its lock). [delaySec]: wait this long first (a retry_after).
     */
    fun download(context: Context, store: FileStore, key: String, f: FileValue, name: String, unmeteredOnly: Boolean, manual: Boolean, delaySec: Long = 0) {
        if (manual) store.markManual(key)
        val net = Constraints.Builder().setRequiredNetworkType(if (unmeteredOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build()
        val b = OneTimeWorkRequestBuilder<FileDownloadWorker>().setConstraints(net)
            .setInputData(workDataOf("key" to key, "file" to f.toJson(), "name" to name, "unmetered" to unmeteredOnly))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG).addTag(TAG + ":" + key)
        if (delaySec > 0) b.setInitialDelay(delaySec, TimeUnit.SECONDS)
        WorkManager.getInstance(context).enqueueUniqueWork("file-$key", if (manual || delaySec > 0) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, b.build())
    }

    /** Times (ms) at which this app's process ended for low memory, as the system recorded them. */
    fun lowMemoryExits(context: Context): List<Long> =
        context.getSystemService(ActivityManager::class.java)?.getHistoricalProcessExitReasons(null, 0, 0)
            ?.filter { it.reason == ApplicationExitInfo.REASON_LOW_MEMORY }?.map { it.timestamp } ?: emptyList()

    /** Bytes the heap can still grow by. */
    fun heapFree(): Long = Runtime.getRuntime().let { it.maxMemory() - (it.totalMemory() - it.freeMemory()) }
}

class FileDownloadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val g = (applicationContext as PaApp).graph
        val key = inputData.getString("key")?.takeIf { FileStore.validKey(it) } ?: return Result.success()
        val f = inputData.getString("file")?.let { InnerMessage.fileValueOf(StrictJson.parseOrNull(it)) } ?: return Result.success()
        val name = inputData.getString("name") ?: return Result.success()
        // manual or automatic is read from the file's folder, never from this job's run count
        val r = withContext(Dispatchers.IO) { g.fileDownload.run(key, f, name) { isStopped } }
        return when (r) {
            is FileDownload.Run.Retry -> {
                // a retry_after longer than the backoff is waited in full
                val wait = r.wait
                if (wait != null && wait > 30) {
                    FileWork.download(applicationContext, g.fileStore, key, f, name, inputData.getBoolean("unmetered", false), manual = false, delaySec = wait)
                    Result.success()
                } else Result.retry()
            }
            FileDownload.Run.Stopped -> Result.retry()
            FileDownload.Run.Done -> { withContext(Dispatchers.IO) { g.files.enforceLimit() }; Result.success() }
            else -> Result.success()
        }
    }
}
