package com.pusharmor.app.files

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.pusharmor.app.Graph
import com.pusharmor.app.PaApp
import com.pusharmor.app.notify.Notifier
import com.pusharmor.app.ui.FileModel
import com.pusharmor.app.ui.UiText
import com.pusharmor.net.ErrorText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Direct Share file sends run here, in a foreground service of type dataSync (a transfer the user started): the
 * app keeps running until each send and the copy it keeps end, whether or not the share dialog is still open. The
 * service's notification shows the progress and goes with the service, also when the app process dies; a mark
 * kept while a send runs then gives that send an error notification and a failed History row at the next start.
 */
class DirectSendService : Service() {
    /** One send: [text] for the progress notification; [run] ends when the send and its kept copy end. */
    class Work(val text: String, val run: suspend CoroutineScope.() -> Unit)

    override fun onBind(intent: Intent?): IBinder? = null

    /** The latest start this service got; on the main thread. */
    private var lastStartId = 0

    // the manifest gives this service foregroundServiceType dataSync; lint does not find it there
    @SuppressLint("ForegroundServiceType")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        current = this
        lastStartId = startId
        val w = pending.poll()
        if (w != null) shown = w.text
        // every start shows the notification at once, as the system requires of a foreground service
        startForeground(Notifier.SENDING_ID, (application as PaApp).graph.notifier.sending(shown, 0), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (w == null) { if (running == 0) stop(); return START_NOT_STICKY }
        running++
        val app = applicationContext
        scope.launch {
            try { coroutineScope { w.run(this) } } finally { ended(app) }
        }
        return START_NOT_STICKY
    }

    /** The system's time limit for this type was reached: the service stops; a send still running goes on to its result. */
    override fun onTimeout(startId: Int, fgsType: Int) = stop()

    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }

    /** Stops the service, unless a newer start is still to come: that start shows the notification again. */
    private fun stop() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelfResult(lastStartId)
    }

    companion object {
        private val pending = ConcurrentLinkedQueue<Work>()
        /** The sends; on the main thread, as is [running]. */
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        private var running = 0
        private var shown = ""
        /** The service while it runs; on the main thread. */
        private var current: DirectSendService? = null

        /**
         * A send ended: with no send left, the service stops and the progress notification goes, also one posted
         * after the service stopped (its time limit) or by a send that runs without the service.
         */
        private fun ended(context: Context) {
            if (--running > 0) return
            current?.stop()
            NotificationManagerCompat.from(context).cancel(Notifier.SENDING_ID)
        }

        /** Runs [w] in the service. If the service cannot start, the send still runs, with no notification. */
        fun start(context: Context, w: Work) {
            pending.add(w)
            try { ContextCompat.startForegroundService(context, Intent(context, DirectSendService::class.java)) } catch (e: Exception) {
                Log.w("PushArmor", "direct send service", e)
                if (pending.remove(w)) {
                    val app = context.applicationContext
                    scope.launch {
                        running++
                        try { coroutineScope { w.run(this) } } finally { ended(app) }
                    }
                }
            }
        }

        /** The marks of running sends, in storage that is not backed up. */
        fun markDir(context: Context) = File(context.noBackupFilesDir, "directsend")

        /** Marks a send of [c] as running; null when the mark cannot be written. Delete it when the send has its result. */
        fun mark(context: Context, c: FileModel.Chosen): File? = try {
            File.createTempFile("send", null, markDir(context).also { it.mkdirs() })
                .also { it.writeText(JSONObject().put("uri", c.uri).put("name", c.name).put("size", c.size).toString()) }
        } catch (e: Exception) { Log.w("PushArmor", "direct send mark", e); null }

        /** The error of a send the app closed during. */
        fun closedText(name: String) = ErrorText.text(UiText.UNABLE_SEND, UiText.directSendClosed(name))

        /**
         * At app start: each mark older than [before] (ms) is a send the app closed during. It gets a failed History
         * row and an error notification, and the mark goes.
         */
        fun reportLeft(g: Graph, before: Long) {
            markDir(g.app).listFiles()?.filter { it.lastModified() < before }?.forEach { f ->
                try {
                    val o = JSONObject(f.readText())
                    val c = FileModel.Chosen(o.getString("uri"), o.getString("name"), o.getLong("size"))
                    val text = closedText(c.name)
                    FileModel.insertFailedRow(g, c, text)
                    if (g.notifier.noticeShows()) g.notifier.notice(text)
                } catch (e: Exception) { Log.w("PushArmor", "direct send left", e) }
                f.delete()
            }
        }
    }
}
