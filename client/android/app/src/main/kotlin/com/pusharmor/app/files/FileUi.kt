package com.pusharmor.app.files

import com.pusharmor.protocol.FileName
import com.pusharmor.protocol.FileRules
import com.pusharmor.protocol.FileRules.FinalCode

/** What the file screens show and decide: pure functions only, so the tables are unit tested. */
object FileUi {
    const val HELPER = "Each received file is available to download for 1 to 24 hours after it is sent, depending on its size"
    /** Directly above the On Wi-Fi and On mobile data rows. */
    const val AUTO_HELPER = "Download received files automatically up to these sizes"
    const val ON_WIFI = "On Wi-Fi"
    const val ON_MOBILE = "On mobile data"
    const val STORAGE_TITLE = "Storage for sent and received files"
    const val STORAGE_HELPER = "When full, the oldest files are removed from this device"
    const val REMOVED = "Removed from this device"
    const val NO_MEMORY = "Not enough memory to decrypt"
    const val PREVIEW_NA = "Preview not available"
    const val CHOOSE_FILE = "Or choose a file..."
    const val REMOVE_FILE = "Remove file"
    const val WILL_SEND_FILE = "Will be sent as file"
    const val EXPIRED = "Expired"

    /** A pasted image while the message box holds text: one type per message. */
    const val PASTE_IMAGE_CLEAR = "Clear the message to add a file"

    // A name in a toast or error is cut in the middle to fit (UiText.cutFile).
    fun noMemoryToast(name: String) = "Not enough memory to decrypt \"${com.pusharmor.app.ui.UiText.cutFile(name)}\""
    fun decryptFailed(name: String) = "Unable to decrypt \"$name\"\nTry again"
    fun tooLarge(name: String) = "\"${com.pusharmor.app.ui.UiText.cutFile(name)}\" is too large to send"
    fun unreadable(name: String) = "Unable to read \"${com.pusharmor.app.ui.UiText.cutFile(name)}\""

    /** The send bar while the file is encrypted: from 0 to encrypted by the bytes read of [total]. */
    fun encryptStep(read: Long, total: Long): Int = bytePercent(read, total) * com.pusharmor.protocol.engine.SendFlow.Step.ENCRYPTED / 100

    /** The send bar during an upload: from encrypted to 100 by the bytes sent of [total]. */
    fun uploadStep(sent: Long, total: Long): Int =
        com.pusharmor.protocol.engine.SendFlow.Step.ENCRYPTED + bytePercent(sent, total) * (100 - com.pusharmor.protocol.engine.SendFlow.Step.ENCRYPTED) / 100

    /** [done] of [total] bytes as a percent, 0 to 100. */
    fun bytePercent(done: Long, total: Long): Int = if (total <= 0) 0 else (minOf(maxOf(done, 0), total) * 100 / total).toInt()

    // ---- auto-download ----

    /** How a download job waits: [ANY] network, or [UNMETERED] only. */
    enum class Auto { ANY, UNMETERED }

    /**
     * The download job a received file gets, or null for none (the row waits for a tap). Data Saver turns the
     * mobile picker Off. A file the mobile picker allows but the Wi-Fi picker does not starts only while the
     * current network is metered ([metered]; null = no network).
     */
    fun auto(size: Long, wifi: Long, mobile: Long, dataSaver: Boolean, metered: Boolean?): Auto? {
        val w = FileRules.autoDownload(FileRules.pickerFor(FileRules.Network.WIFI, wifi, mobile, dataSaver), size)
        val m = FileRules.autoDownload(FileRules.pickerFor(FileRules.Network.MOBILE, wifi, mobile, dataSaver), size)
        return when {
            w && m -> Auto.ANY
            w -> Auto.UNMETERED
            m && metered == true -> Auto.ANY
            else -> null
        }
    }

    /** Catch-up (app open, open from a notification) and arrival: never after expires by the local clock. */
    fun autoNow(size: Long, expires: Long, nowSec: Long, wifi: Long, mobile: Long, dataSaver: Boolean, metered: Boolean?): Auto? =
        if (nowSec >= expires) null else auto(size, wifi, mobile, dataSaver, metered)

    /** What a Paste does in the message box: [IMAGE] takes the clipboard image as the file, [REFUSE] shows [PASTE_IMAGE_CLEAR], [TEXT] pastes as usual. */
    enum class Paste { IMAGE, REFUSE, TEXT }

    fun paste(clipHasImage: Boolean, textEmpty: Boolean): Paste = when {
        !clipHasImage -> Paste.TEXT
        textEmpty -> Paste.IMAGE
        else -> Paste.REFUSE
    }

    fun pickerLabel(bytes: Long): String = if (bytes <= 0) "Off" else "Up to ${bytes / 1_000_000} MB"

    /** A saved picker value that is not one of the choices reads as the default. */
    fun picker(saved: Long?): Long = saved?.takeIf { v -> FileRules.PICKER_SIZES.any { it == v } } ?: FileRules.DEFAULT_PICKER

    // ---- storage limit ----

    val STORAGE_SIZES = longArrayOf(100_000_000, 500_000_000, 1_000_000_000, 5_000_000_000)
    const val DEFAULT_STORAGE = 500_000_000L

    fun storageLabel(bytes: Long): String = if (bytes >= 1_000_000_000) "${bytes / 1_000_000_000} GB" else "${bytes / 1_000_000} MB"

    /** Choices that fit the device's storage ([total] bytes); the smallest always shows. */
    fun storageOptions(total: Long): List<Long> = STORAGE_SIZES.filter { it <= total }.ifEmpty { listOf(STORAGE_SIZES[0]) }

    /** The limit in force: the saved choice (default 500 MB), else the largest choice that fits. */
    fun storageLimit(saved: Long?, total: Long): Long {
        val o = storageOptions(total)
        val s = saved ?: DEFAULT_STORAGE
        return if (s in o) s else o.last { it <= s || it == o.first() }
    }

    /** One stored file: its key, its row time, and the bytes it holds on this device. */
    data class Stored(val key: String, val at: Long, val bytes: Long)

    /** Keys to remove, oldest first, until the rest fit [limit]; the newest file always stays. */
    fun toRemove(files: List<Stored>, limit: Long): List<String> {
        val byAge = files.filter { it.bytes > 0 }.sortedWith(compareBy({ it.at }, { it.key }))
        var total = byAge.sumOf { it.bytes }
        val out = ArrayList<String>()
        for (f in byAge.dropLast(1)) {
            if (total <= limit) break
            out += f.key
            total -= f.bytes
        }
        return out
    }

    // ---- row text ----

    /** "512 bytes", "840 KB", "2.1 MB" (decimal units). */
    fun sizeText(bytes: Long): String = when {
        bytes < 1000 -> "$bytes bytes"
        bytes < 1_000_000 -> "${(bytes + 500) / 1000} KB".let { if (it == "1000 KB") "1.0 MB" else it }
        else -> "%d.%d MB".format((bytes + 50_000) / 1_000_000, ((bytes + 50_000) % 1_000_000) / 100_000)
    }

    /** "expires in 23 h", "expires in 40 min"; [EXPIRED] at or after expires (local clock). */
    fun expiresText(expires: Long, nowSec: Long): String {
        val left = expires - nowSec
        if (left <= 0) return EXPIRED
        return if (left < 3600) "expires in ${(left + 59) / 60} min" else "expires in ${(left + 1799) / 3600} h"
    }

    enum class Kind { IMAGE, PDF, TEXT, CODE, AUDIO, VIDEO, ARCHIVE, OTHER }

    private val KINDS = mapOf(
        Kind.IMAGE to setOf("jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp"),
        Kind.PDF to setOf("pdf"),
        Kind.TEXT to setOf("txt", "md", "csv", "log"),
        Kind.CODE to setOf("html", "htm", "json", "js", "xml", "css", "svg"),
        Kind.AUDIO to setOf("mp3", "m4a", "wav", "ogg", "opus", "flac", "aac"),
        Kind.VIDEO to setOf("mp4", "mov", "webm", "mkv", "3gp", "m4v"),
        Kind.ARCHIVE to setOf("zip", "7z", "tar", "gz", "tgz", "rar", "bz2", "xz"),
    )

    /** Lowercase extension without the dot, or "". */
    fun ext(name: String): String = FileName.splitExt(name).second.drop(1).lowercase()

    /** The icon kind, from the extension only (never trusted for View). */
    fun kind(name: String): Kind = ext(name).let { e -> KINDS.entries.firstOrNull { e in it.value }?.key ?: Kind.OTHER }

    /** "JPEG image", "PDF", "Text", "M4A audio", "MP4 video", "ZIP archive", "DWG file", "File". */
    fun typeLabel(name: String): String {
        val e = ext(name)
        if (e.isEmpty()) return "File"
        val up = if (e == "jpg") "JPEG" else e.uppercase()
        return when (kind(name)) {
            Kind.IMAGE -> "$up image"
            Kind.PDF -> "PDF"
            Kind.TEXT -> "Text"
            Kind.AUDIO -> "$up audio"
            Kind.VIDEO -> "$up video"
            Kind.ARCHIVE -> "$up archive"
            else -> "$up file"
        }
    }

    /** The second line of a file row: "2.1 MB - PDF". */
    fun detail(name: String, size: Long): String = sizeText(size) + " - " + typeLabel(name)

    /** The name a receiver shows and saves under: the file name rule, with its receive time ([atMs]) for a fallback name. */
    fun receivedName(sent: String, atMs: Long): String = FileName.sanitize(sent, atMs / 1000, kind(sent) == Kind.IMAGE)

    // ---- row state ----

    /** What a received file row shows under its name. */
    sealed class Status {
        /** A Download button with [expires] text right of it. */
        data class Pending(val expires: String) : Status()
        data class Downloading(val percent: Int) : Status()
        /** Downloaded; the decrypt runs while History shows. */
        object Decrypting : Status()
        /** [text] in red (grey for [REMOVED]); [download]: a Download button with [expires] right of it. */
        data class Failed(val text: String, val download: Boolean, val expires: String?) : Status()
        /** "Not enough memory to decrypt" and a Decrypt button. */
        object NoMemory : Status()
        /** [decryptFailed] and a Decrypt button. */
        object DecryptFailed : Status()
        object Expired : Status()
        /** The decrypted file is on this device. */
        object Ready : Status()
    }

    /**
     * [running]: a download job of this file runs now; [have]: blob bytes stored; [plainThere]: the decrypted file
     * exists. A tap on Download is always offered while no final error says otherwise.
     */
    fun status(s: FileState, running: Boolean, have: Long, plainThere: Boolean, size: Long, expires: Long, nowSec: Long): Status {
        val exp = expiresText(expires, nowSec)
        if (s.plain != null && plainThere) return Status.Ready
        if (s.memoryError) return Status.NoMemory
        if (s.decryptError && s.downloaded) return Status.DecryptFailed
        // past expires by the local clock, a file not on this device has no Download button
        val gone = !s.downloaded && nowSec >= expires
        when (s.code) {
            null -> {}
            FinalCode.EXPIRED -> return Status.Expired
            FinalCode.DELETED, FinalCode.UPDATE, FinalCode.DAMAGED -> return Status.Failed(s.text ?: FileRules.DOWNLOAD_FAILED, false, null)
            else -> return if (gone) Status.Failed(s.text ?: FileRules.DOWNLOAD_FAILED, false, null) else Status.Failed(s.text ?: FileRules.DOWNLOAD_FAILED, true, exp)
        }
        if (running) return Status.Downloading(if (size + 28 > 0) ((have * 100) / (size + 28)).toInt().coerceIn(0, 99) else 0)
        if (s.downloaded) return Status.Decrypting
        if (gone) return Status.Expired
        return Status.Pending(exp)
    }
}
