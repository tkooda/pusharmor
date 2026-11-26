package com.pusharmor.app.ui

import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.files.DirectSendService
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.notify.Notifier
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.FileCrypt
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.protocol.Peer
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast
import java.io.File
import java.util.Collections

/** A Direct Share of a file sends it at once to that device, with a progress notification; a failure is a notification. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class ShareFileDirectTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val nm get() = app.getSystemService(NotificationManager::class.java)
    private val peer = SoftwareKeyOps.generate()
    private val peerId = "C".repeat(40)
    @Volatile private var shared: File? = null
    private val calls: MutableList<String> = Collections.synchronizedList(ArrayList())
    /** Percents the progress notification showed while the upload ran. */
    private val seen: MutableList<Int> = Collections.synchronizedList(ArrayList())

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    @Before fun setUp() = io {
        // the ViewModel factory keeps the first test's app; each test's activity gets a ViewModel of its own app
        androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory::class.java.getDeclaredField("_instance").apply { isAccessible = true }.set(null, null)
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.store.putPeer(Peer(id = peerId, platform = "android", signPub = B64url.encode(peer.signPub), encPub = B64url.encode(peer.encPub),
            pairingId = ByteArray(8), approved = true, approveVerified = true, name = "Laptop"))
        g.dao.deleteAllHistory()
        g.notifier.ensureChannels()
    }

    @After fun done() {
        // each send ends within its test: the next test starts with no send running
        idleUntil { services.all { shadowOf(it).isStoppedBySelf } }
        doneIo()
    }

    private fun doneIo() = io {
        app.fakeHttp = null
        g.dao.deleteAllHistory()
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    private fun answer(upload: Int, sendResult: String = "sent") {
        app.fakeHttp = Interceptor { chain ->
            val path = chain.request().url.encodedPath
            calls.add(path)
            if (path == "/v1/file") {
                // the share has ended: the shared file can no longer be read
                shared?.delete()
                // the request body is written first: the progress notification has shown
                chain.request().body?.writeTo(okio.Buffer())
                nm.activeNotifications.firstOrNull { it.tag == null && it.id == Notifier.SENDING_ID }
                    ?.let { seen.add(it.notification.extras.getInt(Notification.EXTRA_PROGRESS)) }
            }
            val (code, body) = when (path) {
                "/v1/file" -> upload to if (upload == 201) "{\"id\":\"f1\",\"url\":\"https://files.pusharmor.com/f1\",\"expires\":${System.currentTimeMillis() / 1000 + 86400}}" else "{}"
                "/v1/send" -> 200 to "{\"r\":{\"$peerId\":\"$sendResult\"}}"
                else -> 500 to "{}"
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }
    }

    /** The file send services started; Robolectric runs a started service only when told to. */
    private val services = ArrayList<DirectSendService>()

    /** Runs each service start asked for since the last call. */
    private fun runServices() {
        while (true) {
            val i = shadowOf(app as android.app.Application).nextStartedService ?: return
            if (i.component?.className == DirectSendService::class.java.name)
                services.add(Robolectric.buildService(DirectSendService::class.java, i).create().startCommand(0, services.size + 1).get())
        }
    }

    private fun share(f: File, shortcut: String? = peerId): ShareActivity {
        val i = Intent(app, ShareActivity::class.java).setAction(Intent.ACTION_SEND).setType("application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, Uri.fromFile(f))
        if (shortcut != null) i.putExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID, shortcut)
        val a = Robolectric.buildActivity(ShareActivity::class.java, i).create().get()
        val end = System.currentTimeMillis() + 10_000
        while (!a.isFinishing && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle(); runServices() }
        return a
    }

    /** Waits for the file send service to stop, with its notification gone. */
    private fun assertServiceStopped() {
        val end = System.currentTimeMillis() + 5000
        while (services.any { !shadowOf(it).isStoppedBySelf } && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
        assertTrue(services.isNotEmpty())
        assertTrue(services.all { shadowOf(it).isStoppedBySelf && shadowOf(it).isForegroundStopped })
        assertEquals(null, nm.activeNotifications.firstOrNull { it.id == Notifier.SENDING_ID })
    }

    private fun file(size: Int) = File(app.cacheDir, "doc.pdf").apply { writeBytes(ByteArray(size) { it.toByte() }) }.also { shared = it }

    /** The kept file state of the one file row, after its copy (if any) is done. */
    private fun keptState(): Pair<com.pusharmor.store.HistoryEntity, com.pusharmor.app.files.FileState> {
        val row = io { g.dao.fileRows().single() }
        val k = com.pusharmor.app.files.ReceivedFiles.key(row.id)
        val end = System.currentTimeMillis() + 5000
        while (g.fileStore.state(k).let { it.plain == null && it.code == null } && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
        return row to g.fileStore.state(k)
    }

    private fun notice(id: Int) = nm.activeNotifications.firstOrNull { it.tag == Notifier.TAG_NOTICE && it.id == id }

    @Test fun directShareOfAFileSendsAtOnce() {
        answer(201)
        val a = share(file(300_000))
        assertTrue(a.isFinishing)
        // no tap on Send: the upload and the file message went at once
        assertEquals(listOf("/v1/file", "/v1/send"), calls.filter { it == "/v1/file" || it == "/v1/send" })
        assertTrue(seen.toString(), seen.isNotEmpty())
        assertEquals("Message sent to \"Laptop\"", ShadowToast.getTextOfLatestToast())
        // the sent copy is kept from the bytes the send read, though the shared file was gone after that
        val (row, st) = keptState()
        assertEquals("SENT", row.direction)
        val k = com.pusharmor.app.files.ReceivedFiles.key(row.id)
        val kept = File(g.fileStore.outDir(k), st.plain!!)
        assertTrue(kept.readBytes().contentEquals(ByteArray(300_000) { it.toByte() }))
        assertTrue(FileModel.copyDir(app.cacheDir).listFiles().isNullOrEmpty())
        // the send ran in the foreground service, which ends with its notification after the copy
        assertEquals(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, services.single().foregroundServiceType)
        assertServiceStopped()
        assertTrue(DirectSendService.markDir(app).listFiles().isNullOrEmpty())
    }

    /** A send the app closed during: at the next start its mark gives an error notification and a failed row; a newer mark stays. */
    @Test fun sendLeftByAClosedAppIsReported() {
        val old = DirectSendService.mark(app, FileModel.Chosen("content://x/1", "doc.pdf", 1000))!!.apply { setLastModified(System.currentTimeMillis() - 60_000) }
        val fresh = DirectSendService.mark(app, FileModel.Chosen("content://x/2", "new.pdf", 1000))!!
        try {
            io { DirectSendService.reportLeft(g, System.currentTimeMillis() - 1000) }
            assertTrue(!old.exists() && fresh.exists())
            val text = "Unable to send.\nPushArmor closed before \"doc.pdf\" was sent. Share it again"
            assertEquals(text, notice(Notifier.NOTICE_ID)?.notification?.extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString())
            val (row, st) = keptState()
            assertEquals("SENT", row.direction)
            assertEquals(com.pusharmor.protocol.FileRules.FinalCode.FAILED, st.code)
            val f = com.pusharmor.app.files.ReceivedFiles.fileOf(row)!!
            assertEquals("", f.url)
            assertEquals(1000L, f.size)
            assertEquals(com.pusharmor.app.files.FileUi.Status.Failed(text, false, null),
                com.pusharmor.app.files.FileUi.status(st, false, 0, false, f.size, f.expires, System.currentTimeMillis() / 1000))
        } finally { fresh.delete() }
    }

    @Test fun failedUploadIsANotification() {
        answer(500)
        assertTrue(share(file(1000)).isFinishing)
        assertTrue("/v1/file" in calls)
        assertTrue("/v1/send" !in calls)
        assertServiceStopped()
        val text = "Unable to send.\nThe relay server is not working right now. Try again later."
        assertEquals(text, notice(Notifier.NOTICE_ID)?.notification?.extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString())
        // History has the sent row, in the failed state with the same text and no Download button
        val (row, st) = keptState()
        assertEquals("SENT", row.direction)
        assertEquals(com.pusharmor.protocol.FileRules.FinalCode.FAILED, st.code)
        val f = com.pusharmor.app.files.ReceivedFiles.fileOf(row)!!
        assertEquals(com.pusharmor.app.files.FileUi.Status.Failed(text, false, null),
            com.pusharmor.app.files.FileUi.status(st, false, 0, false, f.size, f.expires, System.currentTimeMillis() / 1000))
        assertTrue(FileModel.copyDir(app.cacheDir).listFiles().isNullOrEmpty())
    }

    /** The Send screen's file send that fails keeps its error on the screen: no History row. */
    @Test fun sendScreenFailureAddsNoRow() {
        answer(500)
        val f = file(1000)
        val r = runBlocking { AppViewModel(app).sendFile(listOf(peerId), FileModel.Chosen(Uri.fromFile(f).toString(), "doc.pdf", 1000)) }
        assertTrue(!r.ok)
        assertEquals(0, io { g.dao.fileRows().size })
    }

    @Test fun deviceThatDidNotGetItShowsOnItsRow() {
        answer(201, "not listening")
        assertTrue(share(file(1000)).isFinishing)
        val row = io { g.dao.fileRows().single() }
        assertTrue(row.results, row.results.contains("not listening"))
        assertEquals("Unable to send to \"Laptop\".\nIt has not listened recently. Run pusharmor listen on it.",
            notice(Notifier.NOTICE_ID)?.notification?.extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString())
    }

    /** A refused file is refused before any send: its toast only, with no notification and no History row. */
    private fun assertRefused(text: String) {
        assertTrue(calls.none { it == "/v1/file" })
        assertEquals(text, ShadowToast.getTextOfLatestToast())
        assertEquals(null, notice(Notifier.NOTICE_ID))
        assertEquals(emptyList<Any>(), io { g.dao.fileRows() })
    }

    @Test fun tooLargeFileIsRefused() {
        answer(201)
        val big = File(app.cacheDir, "big.bin").apply { java.io.RandomAccessFile(this, "rw").use { it.setLength(FileCrypt.MAX_FILE + 1) } }
        try {
            assertTrue(share(big).isFinishing)
            // a file URL gives no display name: the text names it "file"
            assertRefused("\"file\" is too large to send")
        } finally { big.delete() }
    }

    @Test fun unreadableFileIsRefused() {
        answer(201)
        assertTrue(share(File(app.cacheDir, "gone.bin").apply { delete() }).isFinishing)
        assertRefused("Unable to read \"file\"")
    }

    /** With notifications off a refused file is the same toast. */
    @Test fun refusedFileWithNotificationsOffIsAToast() {
        answer(201)
        shadowOf(nm).setNotificationsEnabled(false)
        try {
            assertTrue(share(File(app.cacheDir, "gone.bin").apply { delete() }).isFinishing)
            assertRefused("Unable to read \"file\"")
        } finally { shadowOf(nm).setNotificationsEnabled(true) }
    }

    /** Copies left by an app that closed mid-send go at the next start; one made since then stays. */
    @Test fun startSweepsLeftCopies() {
        val d = FileModel.copyDir(app.cacheDir).apply { mkdirs() }
        val old = File(d, "sent1.tmp").apply { writeText("x"); setLastModified(System.currentTimeMillis() - 60_000) }
        val fresh = File(d, "sent2.tmp").apply { writeText("x") }
        FileModel.sweepCopies(app.cacheDir, System.currentTimeMillis() - 1000)
        assertTrue(!old.exists() && fresh.exists())
        fresh.delete()
    }

    private fun progress() = nm.activeNotifications.firstOrNull { it.id == Notifier.SENDING_ID }

    private fun idleUntil(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 5000
        while (!done() && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
    }

    /** A send that ends while a second share's start is still to come stops the service only up to its own start. */
    @Test fun endedSendDoesNotStopANewerStart() {
        val first = kotlinx.coroutines.CompletableDeferred<Unit>()
        var secondRan = false
        DirectSendService.start(app, DirectSendService.Work("one") { first.await() })
        val s = Robolectric.buildService(DirectSendService::class.java).create().get()
        s.onStartCommand(null, 0, 1)
        DirectSendService.start(app, DirectSendService.Work("two") { secondRan = true; g.notifier.sendingProgress("two", 50) })
        first.complete(Unit)
        idleUntil { shadowOf(s).isStoppedBySelf }
        assertEquals(1, shadowOf(s).stopSelfResultId)
        // the second start comes: it runs, and its end stops the service with the progress notification gone
        s.onStartCommand(null, 0, 2)
        idleUntil { secondRan && shadowOf(s).stopSelfResultId == 2 }
        assertTrue(secondRan)
        assertEquals(2, shadowOf(s).stopSelfResultId)
        assertEquals(null, progress())
    }

    /** A send still running when the service reached its time limit removes its progress notification when it ends. */
    @Test fun sendAfterTimeLimitRemovesItsProgress() {
        val go = kotlinx.coroutines.CompletableDeferred<Unit>()
        var posted = false
        DirectSendService.start(app, DirectSendService.Work("one") { go.await(); g.notifier.sendingProgress("one", 80); posted = true })
        val s = Robolectric.buildService(DirectSendService::class.java).create().get()
        s.onStartCommand(null, 0, 1)
        s.onTimeout(1, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        s.onDestroy()
        go.complete(Unit)
        idleUntil { posted }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(posted)
        assertEquals(null, progress())
    }

    /** When the service cannot start the send still runs; its progress notification goes when it ends. */
    @Test fun sendWithoutTheServiceRemovesItsProgress() {
        val noStart = object : android.content.ContextWrapper(app) {
            override fun startForegroundService(service: Intent?) = throw IllegalStateException("not allowed")
        }
        var ran = false
        DirectSendService.start(noStart, DirectSendService.Work("one") { g.notifier.sendingProgress("one", 50); ran = true })
        idleUntil { ran }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(ran)
        assertEquals(null, progress())
    }

    @Test fun routesOnlyAShortcutInTheAllSet() {
        assertEquals("a", ShareActivity.directFileShortcut("a", listOf("a", "b")))
        assertEquals(null, ShareActivity.directFileShortcut(null, listOf("a")))
        assertEquals(null, ShareActivity.directFileShortcut("zz", listOf("a")))
    }
}
