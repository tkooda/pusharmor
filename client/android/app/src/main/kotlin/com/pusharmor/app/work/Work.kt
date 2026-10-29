package com.pusharmor.app.work

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.pusharmor.app.PaApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.push.PushDispatcher
import com.pusharmor.protocol.Countdown
import com.pusharmor.protocol.engine.PairingEngine
import java.util.concurrent.TimeUnit

/** WorkManager only (section 10): pair sends, coalesced GET /peers, reconcile, token PATCH, daily job. */
object Work {
    const val FETCH_WINDOW_MS = 60_000L
    private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Unique "pair-send-$peer"; taps and the Peers-open re-enqueue use REPLACE (I236). */
    fun pairSend(context: Context, peerId: String, replace: Boolean, delayMs: Long = 0) {
        val b = OneTimeWorkRequestBuilder<PairSendWorker>().setConstraints(net)
            .setInputData(workDataOf("peer" to peerId))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        if (delayMs > 0) b.setInitialDelay(delayMs, TimeUnit.MILLISECONDS) else b.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        WorkManager.getInstance(context).enqueueUniqueWork("pair-send-$peerId", if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, b.build())
    }

    /** Coalesced GET /peers: at most one per 60 s; a trigger inside the window runs at its end (KEEP). */
    fun fetchPeers(context: Context, settings: Settings) {
        val last = settings.get(Settings.K.LAST_FETCH) ?: 0
        val delay = (last + FETCH_WINDOW_MS - System.currentTimeMillis()).coerceAtLeast(0)
        val b = OneTimeWorkRequestBuilder<FetchPeersWorker>().setConstraints(net)
        if (delay > 0) b.setInitialDelay(delay, TimeUnit.MILLISECONDS) else b.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        WorkManager.getInstance(context).enqueueUniqueWork("fetch-peers", ExistingWorkPolicy.KEEP, b.build())
    }

    fun reconcile(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("allow-reconcile", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<ReconcileWorker>().setConstraints(net).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }

    fun patchPush(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("push-patch", ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<PushPatchWorker>().setConstraints(net).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }

    /** One UnifiedPush message or probe; the unique chain keeps them in arrival order. */
    fun upPush(context: Context, probe: String?, m: String?) {
        WorkManager.getInstance(context).enqueueUniqueWork("up-push", ExistingWorkPolicy.APPEND_OR_REPLACE, upPushRequest(probe, m))
    }

    /** A FAILED job fails every request appended behind it on the up-push chain: always succeed. */
    suspend fun neverFail(block: suspend () -> Unit): ListenableWorker.Result {
        try { block() } catch (e: Exception) { Log.w("PushArmor", "UnifiedPush job failed", e) }
        return ListenableWorker.Result.success()
    }

    fun upPushRequest(probe: String?, m: String?): OneTimeWorkRequest = OneTimeWorkRequestBuilder<UpPushWorker>()
        .setInputData(workDataOf("probe" to probe, "m" to m))
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build()

    fun scheduleDaily(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("daily", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<DailyWorker>(1, TimeUnit.DAYS).build())
    }
}

class PairSendWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val g = (applicationContext as PaApp).graph
        val peer = inputData.getString("peer") ?: return Result.success()
        if (g.identity() == null) return Result.success()
        val engine = g.pairing()
        val now = System.currentTimeMillis()
        return when (engine.sendPending(peer, now)) {
            PairingEngine.SendStep.DONE -> Result.success()
            PairingEngine.SendStep.RETRY -> {
                val row = g.store.pairing(peer)
                if (row == null || Countdown.expired(row.startedAt, now) || runAttemptCount > 20) { engine.onSendExhausted(peer); Result.success() } else Result.retry()
            }
            PairingEngine.SendStep.WAIT_UNTIL -> {
                // never sooner than retry_after: the floor is the stored not-before
                val nb = g.store.pairing(peer)?.notBefore ?: now
                Work.pairSend(applicationContext, peer, replace = true, delayMs = (nb - now).coerceAtLeast(1000))
                Result.success()
            }
            PairingEngine.SendStep.STOP -> { engine.onSendExhausted(peer); Result.success() }
        }
    }
}

class FetchPeersWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val g = (applicationContext as PaApp).graph
        return if (g.session.fetchPeers()) Result.success() else Result.retry()
    }
}

class ReconcileWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val g = (applicationContext as PaApp).graph
        if (g.identity() == null) return Result.success()
        g.reconcile().run()
        // ids left in the set (429, 5xx, network) are retried by the next run
        val left = g.store.allowSet().any { g.store.peer(it)?.pinned != true }
        return if (left) Result.retry() else Result.success()
    }
}

class PushPatchWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val g = (applicationContext as PaApp).graph
        if (g.identity() == null) return Result.success()
        return when (g.session.patchPushNow()) {
            true -> Result.success()
            false -> Result.retry()
            null -> Result.success() // 401 "paused": permanent, never retried
        }
    }
}

class UpPushWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = Work.neverFail {
        val g = (applicationContext as PaApp).graph
        val probe = inputData.getString("probe")
        if (probe != null) {
            try { g.session.confirmProbe(probe) } catch (e: Exception) { Log.w("PushArmor", "UnifiedPush probe confirm failed", e) }
        } else PushDispatcher.onPush(g, inputData.getString("m"), fcm = false)
    }
}

/** Daily: history purge, UnifiedPush distributor check, reconcile, pairing timeouts. */
class DailyWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val g = (applicationContext as PaApp).graph
        g.session.purgeHistory()
        if (g.identity() == null) return Result.success()
        g.push.distributorCheck(g)
        Work.reconcile(applicationContext)
        g.session.checkTimeouts(System.currentTimeMillis(), refetch = true)
        return Result.success()
    }
}
