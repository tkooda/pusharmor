package com.pusharmor.app.files

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.FileCrypt
import com.pusharmor.net.FileClient.Fetch
import com.pusharmor.net.FileError
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CancellationException

class FileDownloadTest {
    private val root: File = Files.createTempDirectory("pa-files").toFile()
    private var free = 1L shl 40
    private var clockMs = 1_795_000_000_000L
    private val store = FileStore(root, { clockMs }, { free })
    private val plain = ByteArray(5000) { (it * 31).toByte() }
    private val key = FileCrypt.newKey()
    private val blobBytes = ByteArrayOutputStream().also { FileCrypt.seal(key, ByteArrayInputStream(plain), plain.size.toLong(), it) }.toByteArray()
    private val f = FileValue("https://b2file.pusharmor.com/v1/k", clockMs / 1000 + 600, B64url.encode(key), "a.pdf", plain.size.toLong(), FileCrypt.sha256(ByteArrayInputStream(blobBytes)))

    /** Scripted GETs: each step gets the blob file and returns what the GET did. */
    private val steps = ArrayDeque<(File) -> Fetch>()
    private var calls = 0
    private val dl = FileDownload(store, { _, _, part, _ -> calls++; steps.removeFirst()(part) }, { clockMs / 1000 })

    @After fun clean() { root.deleteRecursively() }

    private fun append(part: File, from: Int, to: Int) = part.appendBytes(blobBytes.copyOfRange(from, to))
    private fun whole(): (File) -> Fetch = { p -> p.writeBytes(blobBytes); Fetch.Done }
    private fun run(manual: Boolean = false): FileDownload.Run {
        if (manual) store.markManual("k1")
        return dl.run("k1", f, "a.pdf")
    }

    @Test fun downloadsAndChecks() {
        steps += whole()
        assertEquals(FileDownload.Run.Done, run())
        assertTrue(store.state("k1").downloaded)
        assertEquals(FileDownload.Run.Done, run())
        assertEquals(1, calls)
    }

    /** WorkManager has no deadline: expires is checked at each start; a tap still sends one GET. */
    @Test fun expiresIsCheckedAtEachStart() {
        steps += { Fetch.Retry(null) }
        assertEquals(FileDownload.Run.Retry(null), run())
        clockMs += 600_000
        assertEquals(FileDownload.Run.Final(FinalCode.EXPIRED, "Expired"), run())
        assertEquals(1, calls)
        steps += whole()
        assertEquals(FileDownload.Run.Done, run(manual = true))
    }

    @Test fun fiveAutomaticAttemptsThenDownloadFailed() {
        repeat(5) { steps += { Fetch.Retry(null) }; assertEquals(FileDownload.Run.Retry(null), run()) }
        assertEquals(FileDownload.Run.Final(FinalCode.FAILED, "Download failed"), run())
        assertEquals(5, calls)
        // the same row until a tap: a tap starts the count again
        assertEquals(FileDownload.Run.Final(FinalCode.FAILED, "Download failed"), run())
        steps += whole()
        assertEquals(FileDownload.Run.Done, run(manual = true))
    }

    /** A system stop that gained bytes is not an attempt; resumed by Range on the next run. */
    @Test fun systemStopsWithBytesDoNotCount() {
        for (i in 0 until 10) steps += { p -> append(p, i * 100, i * 100 + 100); Fetch.Stopped }
        repeat(10) { assertEquals(FileDownload.Run.Stopped, run()) }
        assertEquals(0, store.state("k1").attempts.used)
        repeat(5) { steps += { Fetch.Stopped } } // no bytes: these count
        repeat(5) { assertEquals(FileDownload.Run.Stopped, run()) }
        assertEquals(FileDownload.Run.Final(FinalCode.FAILED, "Download failed"), run())
    }

    /** A killed process leaves its run open; the next start does not count it when it gained bytes. */
    @Test fun killedRunWithBytesDoesNotCount() {
        repeat(4) { steps += { Fetch.Retry(null) }; run() }
        steps += { p -> append(p, 0, 1000); throw CancellationException("killed") }
        try { run(); throw AssertionError() } catch (e: CancellationException) { }
        assertEquals(5, store.state("k1").attempts.used)
        steps += { p -> append(p, 1000, blobBytes.size); Fetch.Done }
        assertEquals(FileDownload.Run.Done, run())
    }

    @Test fun oneReDownloadOnAHashMismatchThenDamaged() {
        steps += { p -> p.writeBytes(blobBytes.copyOf().also { it[100] = (it[100] + 1).toByte() }); Fetch.Done }
        steps += whole()
        assertEquals(FileDownload.Run.Done, run())
        assertEquals(2, calls)
        store.delete("k1")
        steps += { Fetch.Damaged }
        steps += { p -> p.writeBytes(blobBytes.copyOf(10)); Fetch.Done }
        assertEquals(FileDownload.Run.Final(FinalCode.DAMAGED, "Unable to open this file. It is not valid or was damaged."), run())
        assertFalse(store.blob("k1").exists())
    }

    @Test fun storageFullIsFinal() {
        free = 2 * f.size + 10_000_000 - 1
        assertEquals(FileDownload.Run.Final(FinalCode.STORAGE, "Not enough storage to download \"a.pdf\""), run())
        assertEquals(0, calls)
        assertEquals(FileDownload.Run.Final(FinalCode.STORAGE, "Not enough storage to download \"a.pdf\""), run()) // no automatic retry
        free = 2 * f.size + 10_000_000
        steps += whole()
        assertEquals(FileDownload.Run.Done, run(manual = true)) // the Retry button
    }

    @Test fun aFinalRefusalKeepsNoPartialBlob() {
        steps += { p -> append(p, 0, 100); throw FileError(FinalCode.DELETED, "Deleted") }
        assertEquals(FileDownload.Run.Final(FinalCode.DELETED, "Deleted"), run())
        assertFalse(store.blob("k1").exists())
        assertEquals(FileDownload.Run.Final(FinalCode.DELETED, "Deleted"), run())
        assertEquals(1, calls)
    }

    // ---- decrypt ----

    private fun downloaded() { steps += whole(); assertEquals(FileDownload.Run.Done, run()) }

    @Test fun decryptMovesIntoPlaceOnlyAfterTheTag() {
        downloaded()
        val r = store.decrypt("k1", f, "a.pdf", manual = false, heapFree = { 1L shl 30 })
        assertTrue(r is FileStore.Decrypted.Ok)
        assertArrayEquals(plain, (r as FileStore.Decrypted.Ok).file.readBytes())
        assertEquals(setOf("out", "state"), store.dir("k1").list()!!.toSet())
        assertEquals(listOf("a.pdf"), store.outDir("k1").list()!!.toList())
        assertEquals(0L, store.state("k1").markAt)
        assertEquals("a.pdf", store.state("k1").plain)
    }

    /** The decrypted file has its own folder: a name like an internal file harms nothing. */
    @Test fun anyNameIsSafe() {
        for (name in listOf("blob", "state", "state.tmp", "plain.tmp", "manual")) {
            store.delete("k1")
            downloaded()
            val r = store.decrypt("k1", f, name, false, { 1L shl 30 })
            assertArrayEquals(name, plain, (r as FileStore.Decrypted.Ok).file.readBytes())
            assertEquals(name, store.state("k1").plain)
            assertTrue(store.state("k1").downloaded)
            assertEquals(File(store.outDir("k1"), name), r.file)
        }
    }

    /** A resume needs space only for what it has still to store. */
    @Test fun resumeCountsBytesAlreadyStored() {
        val have = 3000
        store.blob("k1").also { it.parentFile.mkdirs() }.writeBytes(blobBytes.copyOf(have))
        free = 2 * f.size + 10_000_000 - have
        steps += { p -> append(p, have, blobBytes.size); Fetch.Done }
        assertEquals(FileDownload.Run.Done, run())
        store.delete("k1")
        free = 2 * f.size + 10_000_000 - 1
        assertEquals(FileDownload.Run.Final(FinalCode.STORAGE, "Not enough storage to download \"a.pdf\""), run())
    }

    /** A tap is taken once: a run after a stop or a killed process is automatic, so it checks expires and counts. */
    @Test fun aTapIsTakenOnce() {
        clockMs += 600_000 // past expires
        steps += { Fetch.Stopped }
        assertEquals(FileDownload.Run.Stopped, run(manual = true))
        assertEquals(FileDownload.Run.Final(FinalCode.EXPIRED, "Expired"), run())
        store.delete("k1")
        steps += { throw CancellationException("killed") }
        try { run(manual = true); throw AssertionError() } catch (e: CancellationException) { }
        assertEquals(FileDownload.Run.Final(FinalCode.EXPIRED, "Expired"), run())
        assertEquals(2, calls)
    }

    /** A tap that lands while a run is in progress is kept for the next run. */
    @Test fun aTapDuringARunIsKept() {
        steps += { store.markManual("k1"); Fetch.Retry(null) }
        assertEquals(FileDownload.Run.Retry(null), run())
        clockMs += 600_000 // past expires: only a manual run sends a GET
        steps += whole()
        assertEquals(FileDownload.Run.Done, run())
        assertEquals(2, calls)
    }

    /** Two runs of one file never overlap: a tap waits for the run in progress. */
    @Test fun runsOfOneFileDoNotOverlap() {
        val inside = java.util.concurrent.atomic.AtomicInteger()
        var most = 0
        val entered = java.util.concurrent.CountDownLatch(1)
        val dl2 = FileDownload(store, { _, _, part, _ ->
            most = maxOf(most, inside.incrementAndGet())
            entered.countDown()
            Thread.sleep(200)
            inside.decrementAndGet()
            Fetch.Retry(null)
        }, { clockMs / 1000 })
        val t = Thread { dl2.run("k1", f, "a.pdf") }
        t.start()
        entered.await()
        store.markManual("k1")
        dl2.run("k1", f, "a.pdf")
        t.join()
        assertEquals(1, most)
        assertEquals(1, store.state("k1").attempts.used) // the tap started the count again
    }

    @Test fun aFailedTagDropsTheBlobForOneReDownloadThenDamaged() {
        val bad = f.copy(key = B64url.encode(FileCrypt.newKey()))
        downloaded()
        assertEquals(FileStore.Decrypted.Redownload, store.decrypt("k1", bad, "a.pdf", false, { 1L shl 30 }))
        assertEquals(setOf("state"), store.dir("k1").list()!!.toSet())
        downloaded()
        assertEquals(FileStore.Decrypted.Final(FinalCode.DAMAGED, "Unable to open this file. It is not valid or was damaged."), store.decrypt("k1", bad, "a.pdf", false, { 1L shl 30 }))
        assertEquals(setOf("state"), store.dir("k1").list()!!.toSet())
    }

    @Test fun aDecryptErrorIsKeptAndClearedByTheNextDecrypt() {
        downloaded()
        store.put("k1", store.state("k1").copy(decryptError = true))
        assertTrue(store.state("k1").decryptError)
        assertTrue(store.decrypt("k1", f, "a.pdf", true, { 1L shl 30 }) is FileStore.Decrypted.Ok)
        assertFalse(store.state("k1").decryptError)
    }

    @Test fun shortMemorySkipsUnlessTheButton() {
        downloaded()
        assertEquals(FileStore.Decrypted.NoMemory, store.decrypt("k1", f, "a.pdf", false, { FileCrypt.WORKING_MEMORY - 1 }))
        assertEquals(0L, store.state("k1").markAt)
        assertTrue(store.state("k1").memoryError)
        // never retried by itself, even with memory now
        assertEquals(FileStore.Decrypted.NoMemory, store.decrypt("k1", f, "a.pdf", false, { 1L shl 30 }))
        assertTrue(store.decrypt("k1", f, "a.pdf", true, { 0 }) is FileStore.Decrypted.Ok)
    }

    @Test fun outOfMemoryIsCaughtAndClearsTheMark() {
        downloaded()
        var marked = 0L
        val r = store.decrypt("k1", f, "a.pdf", true, { 0 }) { marked = store.state("k1").markAt; throw OutOfMemoryError() }
        assertEquals(clockMs, marked)
        assertEquals(FileStore.Decrypted.NoMemory, r)
        assertEquals(0L, store.state("k1").markAt)
        assertTrue(store.state("k1").memoryError)
        assertFalse(File(store.dir("k1"), "plain.tmp").exists())
    }

    @Test fun cancelDeletesTheTempFileAndClearsTheMark() {
        downloaded()
        try { store.decrypt("k1", f, "a.pdf", false, { 1L shl 30 }) { true }; throw AssertionError() } catch (e: CancellationException) { }
        assertEquals(0L, store.state("k1").markAt)
        assertFalse(store.state("k1").memoryError)
        assertEquals(setOf("blob", "state"), store.dir("k1").list()!!.toSet())
        // any other failure also clears the mark and the temp file
        try { store.decrypt("k1", f, "a.pdf", false, { 1L shl 30 }) { throw IllegalStateException("x") }; throw AssertionError() } catch (e: IllegalStateException) { }
        assertEquals(0L, store.state("k1").markAt)
        assertEquals(setOf("blob", "state"), store.dir("k1").list()!!.toSet())
    }

    /** At app start a left mark shows the memory error only after a low-memory exit; else it is cleared. */
    @Test fun marksAreReviewedAtStart() {
        store.put("k1", FileState(downloaded = true, markAt = 1000))
        store.put("k2", FileState(downloaded = true, markAt = 2000))
        File(store.dir("k1"), "plain.tmp").writeBytes(ByteArray(3))
        var asked = 0
        store.reviewMarks({ asked++; listOf(1500L) })
        assertTrue(store.state("k1").memoryError)
        assertFalse(store.state("k2").memoryError)
        assertEquals(0L, store.state("k1").markAt)
        assertEquals(0L, store.state("k2").markAt)
        assertFalse(File(store.dir("k1"), "plain.tmp").exists())
        store.reviewMarks({ asked++; emptyList() }) // no marks: the system is not asked
        assertEquals(1, asked)
        // a mark set by this process (after it started) is left alone
        store.put("k3", FileState(downloaded = true, markAt = clockMs))
        store.reviewMarks({ listOf(clockMs) }, before = clockMs)
        assertEquals(clockMs, store.state("k3").markAt)
    }

    @Test fun sealForSend() {
        val s = store.seal(File(root, "tmp"), ByteArrayInputStream(plain), plain.size.toLong(), "a.pdf")
        assertEquals(plain.size + 28L, s.blob.length())
        assertEquals(FileCrypt.sha256(s.blob.inputStream()), s.sha256)
        val out = ByteArrayOutputStream()
        assertTrue(FileCrypt.open(s.key, s.blob.inputStream(), out))
        assertArrayEquals(plain, out.toByteArray())
        try { store.seal(File(root, "tmp"), ByteArrayInputStream(plain), plain.size + 1L, "a.pdf"); throw AssertionError() } catch (e: com.pusharmor.crypto.FileChangedException) { }
        assertEquals(1, File(root, "tmp").list()!!.size)
    }
}
