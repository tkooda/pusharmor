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
    /** [unmeteredOnly]: the picker allows the file on Wi-Fi only. [manual]: a tap on Download (replaces a queued job). */
    fun download(context: Context, key: String, f: FileValue, name: String, unmeteredOnly: Boolean, manual: Boolean) {
        val net = Constraints.Builder().setRequiredNetworkType(if (unmeteredOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build()
        val req = OneTimeWorkRequestBuilder<FileDownloadWorker>().setConstraints(net)
            .setInputData(workDataOf("key" to key, "file" to f.toJson(), "name" to name, "manual" to manual))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("file-$key", if (manual) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, req)
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
        // only the first run is the tap; later runs are automatic attempts
        val manual = inputData.getBoolean("manual", false) && runAttemptCount == 0
        val r = withContext(Dispatchers.IO) { g.fileDownload.run(key, f, name, manual) { isStopped } }
        return when (r) {
            is FileDownload.Run.Retry, FileDownload.Run.Stopped -> Result.retry()
            else -> Result.success()
        }
    }
}
