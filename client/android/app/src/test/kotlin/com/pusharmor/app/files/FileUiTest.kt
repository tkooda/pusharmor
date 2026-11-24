package com.pusharmor.app.files

import com.pusharmor.app.files.FileUi.Auto
import com.pusharmor.app.files.FileUi.Status
import com.pusharmor.protocol.FileRules.FinalCode
import org.junit.Assert.assertEquals
import org.junit.Test

/** The file screen tables: auto-download, the storage limit, row text, and row state. */
class FileUiTest {
    private val mb = 1_000_000L

    /** network x picker x size -> the job a file gets (the shared table, Data Saver included). */
    @Test fun autoTable() {
        // wifi, mobile, dataSaver, metered, size -> job
        val rows = listOf(
            listOf(50 * mb, 50 * mb, false, true, 50 * mb, Auto.ANY),
            listOf(50 * mb, 50 * mb, false, false, 50 * mb + 1, null),
            listOf(100 * mb, 10 * mb, false, true, 25 * mb, Auto.UNMETERED),
            listOf(100 * mb, 10 * mb, false, false, 100 * mb, Auto.UNMETERED),
            listOf(0L, 0L, false, false, 1L, null),
            listOf(0L, 50 * mb, false, true, 1L, Auto.ANY),
            listOf(0L, 50 * mb, false, false, 1L, null),
            listOf(0L, 50 * mb, false, null, 1L, null),
            // Data Saver turns the mobile picker Off
            listOf(50 * mb, 50 * mb, true, true, 10 * mb, Auto.UNMETERED),
            listOf(0L, 50 * mb, true, true, 10 * mb, null),
            // never above the cap
            listOf(100 * mb, 100 * mb, false, false, 100 * mb + 1, null),
        )
        for (r in rows) assertEquals(r.toString(), r[5], FileUi.auto(r[4] as Long, r[0] as Long, r[1] as Long, r[2] as Boolean, r[3] as Boolean?))
    }

    @Test fun neverAfterExpiresByTheLocalClock() {
        assertEquals(Auto.ANY, FileUi.autoNow(1, 1000, 999, 50 * mb, 50 * mb, false, true))
        assertEquals(null, FileUi.autoNow(1, 1000, 1000, 50 * mb, 50 * mb, false, true))
    }

    @Test fun pickers() {
        assertEquals(listOf("Off", "Up to 10 MB", "Up to 25 MB", "Up to 50 MB", "Up to 100 MB"), com.pusharmor.protocol.FileRules.PICKER_SIZES.map(FileUi::pickerLabel))
        assertEquals(50 * mb, FileUi.picker(null))
        assertEquals(50 * mb, FileUi.picker(7))
        assertEquals(0L, FileUi.picker(0))
        assertEquals("Larger files expire sooner, between 1 and 24 hours after they are sent", FileUi.HELPER)
    }

    @Test fun storageChoicesFitTheDevice() {
        assertEquals(listOf("100 MB", "500 MB", "1 GB", "5 GB"), FileUi.storageOptions(64_000_000_000).map(FileUi::storageLabel))
        assertEquals(listOf(100 * mb, 500 * mb, 1000 * mb), FileUi.storageOptions(4_000_000_000))
        assertEquals(500 * mb, FileUi.storageLimit(null, 64_000_000_000))
        // an unsupported choice falls back to the largest that fits
        assertEquals(1000 * mb, FileUi.storageLimit(5000 * mb, 4_000_000_000))
        assertEquals(100 * mb, FileUi.storageLimit(null, 200 * mb))
    }

    @Test fun oldestFilesGoFirstAndTheNewestStays() {
        val files = listOf(FileUi.Stored("b", 2, 60 * mb), FileUi.Stored("a", 1, 50 * mb), FileUi.Stored("c", 3, 40 * mb))
        assertEquals(emptyList<String>(), FileUi.toRemove(files, 150 * mb))
        assertEquals(listOf("a"), FileUi.toRemove(files, 100 * mb))
        assertEquals(listOf("a", "b"), FileUi.toRemove(files, 50 * mb))
        assertEquals(listOf("a", "b"), FileUi.toRemove(files, 10 * mb))
    }

    @Test fun rowText() {
        assertEquals("512 bytes", FileUi.sizeText(512))
        assertEquals("840 KB", FileUi.sizeText(840_000))
        assertEquals("2.1 MB", FileUi.sizeText(2_100_000))
        assertEquals("100.0 MB", FileUi.sizeText(100 * mb))
        assertEquals("2.1 MB - PDF", FileUi.detail("quarterly-report.pdf", 2_100_000))
        assertEquals("JPEG image", FileUi.typeLabel("IMG_1.jpg"))
        assertEquals("M4A audio", FileUi.typeLabel("voice.m4a"))
        assertEquals("MP4 video", FileUi.typeLabel("clip.mp4"))
        assertEquals("ZIP archive", FileUi.typeLabel("photos.zip"))
        assertEquals("DWG file", FileUi.typeLabel("plan.dwg"))
        assertEquals("Text", FileUi.typeLabel("notes.txt"))
        assertEquals("File", FileUi.typeLabel("README"))
        assertEquals("expires in 24 h", FileUi.expiresText(86_400, 0))
        assertEquals("expires in 23 h", FileUi.expiresText(23 * 3600 + 100, 0))
        assertEquals("expires in 40 min", FileUi.expiresText(2400, 0))
        assertEquals("Expired", FileUi.expiresText(10, 10))
        assertEquals("Not enough memory to decrypt \"a.jpg\"", FileUi.noMemoryToast("a.jpg"))
    }

    @Test fun rowState() {
        val s = FileState()
        assertEquals(Status.Pending("expires in 1 h"), FileUi.status(s, false, 0, false, 100, 3600, 0))
        assertEquals(Status.Downloading(50), FileUi.status(s, true, 64, false, 100, 3600, 0))
        assertEquals(Status.Decrypting, FileUi.status(s.copy(downloaded = true), false, 128, false, 100, 3600, 0))
        assertEquals(Status.NoMemory, FileUi.status(s.copy(downloaded = true, memoryError = true), false, 128, false, 100, 3600, 0))
        assertEquals(Status.Ready, FileUi.status(s.copy(plain = "a.pdf"), false, 0, true, 100, 3600, 0))
        assertEquals(Status.Expired, FileUi.status(s.copy(code = FinalCode.EXPIRED, text = "Expired"), false, 0, false, 100, 3600, 0))
        assertEquals(Status.Failed("Deleted", false, null), FileUi.status(s.copy(code = FinalCode.DELETED, text = "Deleted"), false, 0, false, 100, 3600, 0))
        // storage full keeps its Download button
        assertEquals(Status.Failed("Not enough storage to download \"a.pdf\"", true, "expires in 1 h"),
            FileUi.status(s.copy(code = FinalCode.STORAGE, text = "Not enough storage to download \"a.pdf\""), false, 0, false, 100, 3600, 0))
        // past expires by the local clock: no Download button
        assertEquals(Status.Expired, FileUi.status(s, false, 0, false, 100, 3600, 3600))
        assertEquals(Status.Failed(FileUi.REMOVED, false, null), FileUi.status(s.copy(code = FinalCode.FAILED, text = FileUi.REMOVED), false, 0, false, 100, 3600, 3600))
        assertEquals(Status.Failed(FileUi.REMOVED, true, "expires in 1 h"), FileUi.status(s.copy(code = FinalCode.FAILED, text = FileUi.REMOVED), false, 0, false, 100, 3600, 0))
    }

    @Test fun pasteAnImageOnlyIntoAnEmptyBox() {
        assertEquals(FileUi.Paste.IMAGE, FileUi.paste(clipHasImage = true, textEmpty = true))
        assertEquals(FileUi.Paste.REFUSE, FileUi.paste(clipHasImage = true, textEmpty = false))
        assertEquals(FileUi.Paste.TEXT, FileUi.paste(clipHasImage = false, textEmpty = false))
        assertEquals("Clear the message to paste an image", FileUi.PASTE_IMAGE_CLEAR)
    }

    @Test fun dataSaverAllowListedCountsAsOff() {
        assertEquals(true, FileUi.dataSaverOn(android.net.ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED))
        assertEquals(false, FileUi.dataSaverOn(android.net.ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED))
        assertEquals(false, FileUi.dataSaverOn(android.net.ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED))
    }

    @Test fun onlyDecryptedFilesAreServed() {
        assertEquals(true, OutFileProvider.served(listOf("received", "12", "out", "a.pdf")))
        assertEquals(false, OutFileProvider.served(listOf("received", "12", "blob")))
        assertEquals(false, OutFileProvider.served(listOf("received", "12", "state")))
        assertEquals(false, OutFileProvider.served(listOf("received", "12", "out", "..")))
        assertEquals(false, OutFileProvider.served(listOf("received", "..", "out", "a")))
    }

    @Test fun fileSendCaptions() {
        assertEquals("Sending file to \"Laptop\"...", com.pusharmor.app.ui.UiText.directSendingFile(listOf("Laptop")))
        assertEquals("Sending file to:", com.pusharmor.app.ui.UiText.directSendingFileList())
    }
}
