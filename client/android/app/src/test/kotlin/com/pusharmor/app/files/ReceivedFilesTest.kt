package com.pusharmor.app.files

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import com.pusharmor.store.HistoryEntity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** Download jobs on arrival and catch-up, row deletes, the storage limit, and the logout wipe. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class ReceivedFilesTest {
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val g get() = app.graph
    private val queued = ArrayList<String>()
    private val cancelled = ArrayList<String>()
    private val now = 1_800_000_000L
    private lateinit var store: FileStore
    private lateinit var files: ReceivedFiles

    @Before fun setUp() {
        store = FileStore(File(app.filesDir, "rf-test").also { it.deleteRecursively() })
        files = ReceivedFiles(app, g.settings, g.dao, store, { key, f, name, u, manual -> queued += "$key:$name:${if (u) "wifi" else "any"}:$manual:${f.size}" },
            { cancelled += it }, { now })

    }

    /** Room refuses the main thread. */
    private fun io(b: () -> Unit) = kotlinx.coroutines.runBlocking(kotlinx.coroutines.Dispatchers.IO) { b() }

    @After fun tearDown() { store.root.deleteRecursively() }

    /** 43 chars of b64url (32 bytes 0..31). */
    private val key43 = com.pusharmor.crypto.B64url.encode(ByteArray(32) { it.toByte() })

    private fun row(name: String, size: Long, expires: Long, at: Long = now * 1000, direction: String = "RECEIVED"): Long =
        g.dao.insertHistory(HistoryEntity(direction = direction, peerId = null, type = "file", content = FileValue("https://b2file.pusharmor.com/v1/x", expires, key43, name, size, key43).toJson(),
            n = null, pairingId = null, at = at, read = true, results = "", count = 1))

    @Test fun catchUpQueuesWhatThePickersAllow() = io {
        g.settings.set(Settings.K.FILE_WIFI, 100_000_000L)
        g.settings.set(Settings.K.FILE_MOBILE, 0L)
        val small = row("a.pdf", 1000, now + 3600)
        val expired = row("b.pdf", 1000, now)
        val done = row("c.pdf", 1000, now + 3600)
        store.put(ReceivedFiles.key(done), FileState(downloaded = true))
        val failed = row("d.pdf", 1000, now + 3600)
        store.put(ReceivedFiles.key(failed), FileState(code = FinalCode.DAMAGED))
        row("e.pdf", 1000, now + 3600, direction = "SENT")
        files.catchUp()
        // Wi-Fi only: the job waits for an unmetered network (the network-change catch-up, with no polling)
        assertEquals(listOf("$small:a.pdf:wifi:false:1000"), queued)
        assertFalse(queued.any { it.startsWith("$expired:") })
    }

    @Test fun offQueuesNothingAndATapAlwaysQueues() = io {
        g.settings.set(Settings.K.FILE_WIFI, 0L)
        g.settings.set(Settings.K.FILE_MOBILE, 0L)
        val id = row("big.mp4", 90_000_000, now + 3600)
        files.onArrived(id, FileValue("https://b2file.pusharmor.com/v1/x", now + 3600, key43, "big.mp4", 90_000_000, key43))
        files.catchUp()
        assertTrue(queued.isEmpty())
        files.download(g.dao.history(id)!!)
        assertEquals(listOf("$id:big.mp4:any:true:90000000"), queued)
    }

    @Test fun deletedRowsDropTheirFiles() = io {
        val id = row("a.pdf", 10, now + 3600)
        store.put(ReceivedFiles.key(id), FileState(downloaded = true))
        store.put("999999", FileState(downloaded = true))
        files.catchUp() // the file of a row that is gone goes
        assertFalse(store.dir("999999").exists())
        assertTrue(store.dir(ReceivedFiles.key(id)).exists())
        files.forget(listOf(id))
        assertFalse(store.dir(ReceivedFiles.key(id)).exists())
        assertTrue(ReceivedFiles.key(id) in cancelled)
    }

    @Test fun oldestGoFirstAndLogoutRemovesAll() = io {
        g.settings.set(Settings.K.FILE_STORAGE, 100_000_000L)
        val old = row("old.bin", 60_000_000, now + 3600, at = 1000)
        val new = row("new.bin", 60_000_000, now + 3600, at = 2000)
        for (id in listOf(old, new)) {
            val k = ReceivedFiles.key(id)
            store.outDir(k).mkdirs()
            java.io.RandomAccessFile(File(store.outDir(k), "x.bin"), "rw").use { it.setLength(60_000_000) }
            store.put(k, FileState(plain = "x.bin"))
        }
        files.enforceLimit()
        assertEquals(FileUi.REMOVED, store.state(ReceivedFiles.key(old)).text)
        assertEquals("x.bin", store.state(ReceivedFiles.key(new)).plain)
        files.wipe()
        assertEquals(FileUi.REMOVED, store.state(ReceivedFiles.key(new)).text)
        assertFalse(File(store.outDir(ReceivedFiles.key(new)), "x.bin").exists())
        // a removed file is not downloaded again by catch-up
        queued.clear()
        files.catchUp()
        assertTrue(queued.isEmpty())
    }
}
