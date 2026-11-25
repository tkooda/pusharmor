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

    @After fun done() = io {
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
                nm.activeNotifications.firstOrNull { it.tag == Notifier.TAG_NOTICE && it.id == Notifier.SENDING_ID }
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

    private fun share(f: File, shortcut: String? = peerId): ShareActivity {
        val i = Intent(app, ShareActivity::class.java).setAction(Intent.ACTION_SEND).setType("application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, Uri.fromFile(f))
        if (shortcut != null) i.putExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID, shortcut)
        val a = Robolectric.buildActivity(ShareActivity::class.java, i).create().get()
        val end = System.currentTimeMillis() + 10_000
        while (!a.isFinishing && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
        return a
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
        assertEquals(null, notice(Notifier.SENDING_ID))
        assertEquals("Message sent to \"Laptop\"", ShadowToast.getTextOfLatestToast())
        // the sent copy is kept from the bytes the send read, though the shared file was gone after that
        val (row, st) = keptState()
        assertEquals("SENT", row.direction)
        val k = com.pusharmor.app.files.ReceivedFiles.key(row.id)
        val kept = File(g.fileStore.outDir(k), st.plain!!)
        assertTrue(kept.readBytes().contentEquals(ByteArray(300_000) { it.toByte() }))
        assertTrue(FileModel.copyDir(app.cacheDir).listFiles().isNullOrEmpty())
    }

    @Test fun failedUploadIsANotification() {
        answer(500)
        assertTrue(share(file(1000)).isFinishing)
        assertTrue("/v1/file" in calls)
        assertTrue("/v1/send" !in calls)
        assertEquals(null, notice(Notifier.SENDING_ID))
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

    @Test fun tooLargeFileIsRefused() {
        answer(201)
        val big = File(app.cacheDir, "big.bin").apply { java.io.RandomAccessFile(this, "rw").use { it.setLength(FileCrypt.MAX_FILE + 1) } }
        try {
            assertTrue(share(big).isFinishing)
            // a file URL gives no display name: the toast names it "file"
            assertEquals("\"file\" is too large to send", ShadowToast.getTextOfLatestToast())
            assertTrue(calls.none { it == "/v1/file" })
        } finally { big.delete() }
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

    @Test fun routesOnlyAShortcutInTheAllSet() {
        assertEquals("a", ShareActivity.directFileShortcut("a", listOf("a", "b")))
        assertEquals(null, ShareActivity.directFileShortcut(null, listOf("a")))
        assertEquals(null, ShareActivity.directFileShortcut("zz", listOf("a")))
    }
}
