package com.pusharmor.app.files

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.ui.FileModel
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import com.pusharmor.protocol.engine.ApiResult
import com.pusharmor.protocol.engine.SendFlow
import com.pusharmor.store.HistoryEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

/** A sent file keeps a copy that is stored, shown, and removed as a downloaded received file. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SentFilesTest {
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val g get() = app.graph
    private val bytes = ByteArray(5000) { (it * 7).toByte() }
    private val nowSec = System.currentTimeMillis() / 1000
    private val key43 = com.pusharmor.crypto.B64url.encode(ByteArray(32) { it.toByte() })
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val m = FileModel(g, scope) {}

    @After fun tearDown() { g.fileStore.root.deleteRecursively() }

    /** Room refuses the main thread. */
    private fun io(b: () -> Unit) = runBlocking(Dispatchers.IO) { b() }

    private fun sentRow(name: String, size: Long = bytes.size.toLong(), at: Long = System.currentTimeMillis()): Long =
        g.dao.insertHistory(HistoryEntity(direction = "SENT", peerId = null, type = "file", content = FileValue("https://b2file.pusharmor.com/v1/x", nowSec + 3600, key43, name, size, key43).toJson(),
            n = null, pairingId = null, at = at, read = true, results = "", count = 1))

    private fun picked(name: String): FileModel.Chosen {
        val f = File(app.cacheDir, "picked-$name").also { it.writeBytes(bytes) }
        return FileModel.Chosen(Uri.fromFile(f).toString(), name, bytes.size.toLong())
    }

    private fun row(id: Long): FileModel.Row? { runBlocking { m.refresh(decrypt = false).join() }; return m.rows.value[id] }

    @Test fun aSentFileKeepsACopyWithTheActionsOfADownloadedFile() = io {
        val id = sentRow("a.pdf")
        m.keepSent(id, picked("a.pdf"), "a.pdf")
        val k = ReceivedFiles.key(id)
        val s = g.fileStore.state(k)
        assertEquals("a.pdf", s.plain)
        assertTrue(s.downloaded)
        assertArrayEquals(bytes, File(g.fileStore.outDir(k), "a.pdf").readBytes())
        assertFalse(File(g.fileStore.dir(k), "plain.tmp").exists())
        val r = row(id)!!
        // Ready with the file in place: History shows the actions of a received file
        assertEquals(FileUi.Status.Ready, r.status)
        assertEquals("a.pdf", r.name)
    }

    @Test fun aFailedSendKeepsNothing() {
        val ok = mapOf("p1" to "sent", "p2" to "offline")
        assertEquals(7L, FileModel.keptRow(SendFlow.Outcome(ok, 2, historyId = 7)))
        assertNull(FileModel.keptRow(SendFlow.Outcome(mapOf("p1" to "offline"), 1, historyId = 7)))
        assertNull(FileModel.keptRow(SendFlow.Outcome(emptyMap(), 1, ApiResult.Network)))
        assertNull(FileModel.keptRow(SendFlow.Outcome(ok, 2)))
    }

    @Test fun anUnreadablePickedFileKeepsNothingAndShowsTheRowError() = io {
        val id = sentRow("a.pdf")
        m.keepSent(id, FileModel.Chosen(Uri.fromFile(File(app.cacheDir, "gone.pdf")).toString(), "a.pdf", 10), "a.pdf")
        val k = ReceivedFiles.key(id)
        assertFalse(g.fileStore.outDir(k).exists())
        val r = row(id)!!
        assertEquals(FileUi.Status.Failed(FileUi.unreadable("a.pdf"), true, FileUi.expiresText(nowSec + 3600, nowSec)), r.status)
    }

    @Test fun rowDeleteAndHistoryAutoDeleteRemoveTheCopy() = io {
        val a = sentRow("a.pdf")
        m.keepSent(a, picked("a.pdf"), "a.pdf")
        g.files.forget(listOf(a))
        assertFalse(g.fileStore.dir(ReceivedFiles.key(a)).exists())
        val old = sentRow("b.pdf", at = 1000)
        m.keepSent(old, picked("b.pdf"), "b.pdf")
        assertTrue(g.fileStore.dir(ReceivedFiles.key(old)).exists())
        g.session.purgeHistory()
        g.files.catchUp()
        assertFalse(g.fileStore.dir(ReceivedFiles.key(old)).exists())
    }

    /** Storage full: the row error of a received download, and nothing is kept. */
    @Test fun storageFullIsTheErrorOfADownload() {
        val root = Files.createTempDirectory("pa-sent").toFile()
        try {
            val store = FileStore(root, usableSpace = { 6000 })
            assertFalse(store.keepSent("1", ByteArrayInputStream(bytes), bytes.size.toLong(), "a.pdf"))
            val s = store.state("1")
            assertEquals(FinalCode.STORAGE, s.code)
            assertEquals("Not enough storage to download \"a.pdf\"", s.text)
            assertFalse(store.outDir("1").exists())
            assertEquals(FileUi.Status.Failed(s.text!!, true, "x"), FileUi.status(s, false, 0, false, bytes.size.toLong(), nowSec + 3600, nowSec).let { (it as FileUi.Status.Failed).copy(expires = "x") })
        } finally { root.deleteRecursively() }
    }

    /** A copy removed by the storage limit or logout says "Removed from this device" and has Download, which gets it again as a received file. */
    @Test fun aRemovedCopyHasDownloadLikeAReceivedFile() = io {
        val id = sentRow("a.pdf")
        m.keepSent(id, picked("a.pdf"), "a.pdf")
        g.files.wipe()
        val r = row(id)!!
        assertEquals(FileUi.Status.Failed(FileUi.REMOVED, true, FileUi.expiresText(nowSec + 3600, nowSec)), r.status)
        assertFalse(File(g.fileStore.outDir(ReceivedFiles.key(id)), "a.pdf").exists())
        val queued = ArrayList<String>()
        val files = ReceivedFiles(app, g.settings, g.dao, g.fileStore, { key, f, name, _, manual -> queued += "$key:$name:$manual:${f.size}" }, {}, { nowSec })
        files.download(g.dao.history(id)!!)
        assertEquals(listOf("$id:a.pdf:true:${bytes.size}"), queued)
    }

    /** The storage limit counts sent copies with received files. */
    @Test fun theStorageLimitCountsSentCopies() = io {
        g.settings.set(Settings.K.FILE_STORAGE, 100_000_000L)
        val big = sentRow("big.bin", 60_000_000, at = 1000)
        val k = ReceivedFiles.key(big)
        g.fileStore.outDir(k).mkdirs()
        java.io.RandomAccessFile(File(g.fileStore.outDir(k), "big.bin"), "rw").use { it.setLength(60_000_000) }
        g.fileStore.put(k, FileState(downloaded = true, plain = "big.bin"))
        val next = sentRow("n.bin", 60_000_000, at = 2000)
        val c = File(app.cacheDir, "picked-n.bin").also { f -> java.io.RandomAccessFile(f, "rw").use { it.setLength(60_000_000) } }
        m.keepSent(next, FileModel.Chosen(Uri.fromFile(c).toString(), "n.bin", 60_000_000), "n.bin")
        assertEquals(FileUi.REMOVED, g.fileStore.state(k).text)
        assertEquals("n.bin", g.fileStore.state(ReceivedFiles.key(next)).plain)
        c.delete()
    }
}
