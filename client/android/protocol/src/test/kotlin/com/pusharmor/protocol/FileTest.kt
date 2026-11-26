package com.pusharmor.protocol

import com.pusharmor.crypto.FileVectors
import com.pusharmor.crypto.bool
import com.pusharmor.crypto.long
import com.pusharmor.crypto.str
import com.pusharmor.protocol.FileRules.Attempts
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileRules.Network
import com.pusharmor.protocol.FileRules.Outcome
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileTest {
    @Test fun nameVectors() {
        val time = FileVectors.section("names").long("time")
        val cases = FileVectors.cases("names")
        assertTrue(cases.size >= 40)
        for (c in cases) {
            val t = if (c["time"] != null && c["time"] !is JsonNull) c.long("time") else time
            assertEquals(c.toString(), c.str("output"), FileName.sanitize(c.str("input"), t, c.bool("image")))
        }
    }

    @Test fun collisionVectors() {
        // the app saves through the system picker and matches no names itself; FileName.collide is the ignore_case mode
        for (c in FileVectors.cases("collision").filter { it.str("mode") == "ignore_case" }) {
            assertEquals(c.str("name"), c.str("output"), FileName.collide(c.str("input"), c["existing"]!!.jsonArray.map { it.jsonPrimitive.content }))
        }
    }

    /** The catch-up table: network x picker x size -> download, for phones (both pickers), browsers and the command line. */
    @Test fun autoDownloadVectors() {
        val cases = FileVectors.cases("auto_download")
        assertTrue(cases.size >= 100)
        for (c in cases) {
            val size = c.long("size")
            val got = when (c.str("client")) {
                "phone" -> {
                    val net = if (c.str("network") == "wifi") Network.WIFI else Network.MOBILE
                    val p = c.long("picker")
                    val other = FileRules.PICKER_SIZES.last() - p // the other picker must not matter
                    val picker = if (net == Network.WIFI) FileRules.pickerFor(net, p, other, c.bool("data_saver")) else FileRules.pickerFor(net, other, p, c.bool("data_saver"))
                    FileRules.autoDownload(picker, size) && FileRules.catchUpDue(size, 2000, picker, 1999)
                }
                "browser" -> FileRules.autoDownload(c.long("picker"), size)
                else -> FileRules.autoDownload(FileRules.PICKER_SIZES.last(), size) // listen --files: every file up to MAX_FILE
            }
            assertEquals(c.toString(), c.bool("download"), got)
        }
    }

    @Test fun catchUpNeverStartsAtOrAfterExpires() {
        assertTrue(FileRules.catchUpDue(1, 100, FileRules.DEFAULT_PICKER, 99))
        assertTrue(!FileRules.catchUpDue(1, 100, FileRules.DEFAULT_PICKER, 100))
        assertTrue(!FileRules.catchUpDue(1, 100, 0, 0))
    }

    @Test fun freeSpace() {
        assertTrue(FileRules.enoughStorage(null, 100_000_000))
        assertTrue(FileRules.enoughStorage(2 * 1000 + 10_000_000L, 1000))
        assertTrue(!FileRules.enoughStorage(2 * 1000 + 10_000_000L - 1, 1000))
        assertEquals("Not enough storage to download \"a.pdf\"", FileRules.storageFullText(false, "a.pdf"))
        // a long name is cut in the middle to 24 characters: its first 14, "...", and its last 7
        val long = "my-very-long-vacation-photo-2026.jpg"
        assertEquals("my-very-long-v...026.jpg", FileName.cut(long))
        assertEquals("x".repeat(24), FileName.cut("x".repeat(24)))
        assertEquals("Not enough storage to download \"my-very-long-v...026.jpg\"", FileRules.storageFullText(false, long))
        assertEquals("Not enough storage to send \"my-very-long-v...026.jpg\"", FileRules.storageFullText(true, long))
        assertEquals("Not enough storage to send \"a.pdf\"", FileRules.storageFullText(true, "a.pdf"))
    }

    @Test fun statusTable() {
        fun up(s: Int, e: String? = null, ra: Long? = null) = FileRules.fileStatus(true, s, e, ra)
        fun down(s: Int, e: String? = null, ra: Long? = null, now: Long = 0, exp: Long = 0) = FileRules.fileStatus(false, s, e, ra, now, exp)
        assertEquals(Outcome.Final(FinalCode.QUOTA, "You reached your file limit. Try again in 2 hours"), up(429, "file quota", 3601))
        assertEquals(Outcome.Final(FinalCode.QUOTA, "You reached your file limit. Try again later"), up(429, "file quota"))
        assertEquals(Outcome.Retry(30), up(429, "rate limited", 30))
        assertEquals(Outcome.Final(FinalCode.PAUSED, "File sending is over quota and paused for 5 minutes"), down(503, "files paused", 300))
        assertEquals(Outcome.Final(FinalCode.PAUSED, "File sending is paused. Try again later"), up(503, "files paused"))
        assertEquals(Outcome.Retry(null), up(0))
        assertEquals(Outcome.Retry(null), down(502))
        assertEquals(Outcome.Retry(null), up(500, "x", 0))
        assertEquals(Outcome.Final(FinalCode.UPDATE, null), up(426))
        assertEquals(Outcome.Final(FinalCode.TOO_LARGE, null), up(413))
        assertEquals(Outcome.Final(FinalCode.FAILED, null), up(403, "unapproved"))
        assertEquals(Outcome.Final(FinalCode.EXPIRED, "Expired"), down(410))
        assertEquals(Outcome.Final(FinalCode.UPDATE, "Update the app"), down(404, "update required"))
        assertEquals(Outcome.Final(FinalCode.DELETED, "Deleted"), down(404, now = 99, exp = 100))
        assertEquals(Outcome.Final(FinalCode.EXPIRED, "Expired"), down(404, now = 100, exp = 100))
        assertEquals(Outcome.Final(FinalCode.FAILED, "Download failed"), down(403))
    }

    @Test fun waits() {
        assertEquals("1 minute", FileRules.fileWait(1))
        assertEquals("59 minutes", FileRules.fileWait(3540))
        assertEquals("1 hour", FileRules.fileWait(3599))
        assertEquals("1 hour", FileRules.fileWait(3600))
        assertEquals("2 hours", FileRules.fileWait(3601))
        assertEquals("47 hours", FileRules.fileWait(47 * 3600))
        assertEquals("2 days", FileRules.fileWait(47 * 3600 + 1))
        assertEquals("3 days", FileRules.fileWait(2 * 86400 + 1))
    }

    /** Five automatic attempts; each run counts when it starts, a run ended by itself stays counted. */
    @Test fun attemptsCapAtFive() {
        var a = Attempts()
        repeat(5) { a = a.start(0)!!.end() }
        assertEquals(5, a.used)
        assertNull(a.start(0))
    }

    /** A system stop that gained bytes does not count; one that gained none does. */
    @Test fun systemStopWithBytesDoesNotCount() {
        var a = Attempts()
        repeat(10) { i -> a = a.start(i * 100L)!!.stopped(i * 100L + 50) }
        assertEquals(0, a.used)
        a = a.start(1000)!!.stopped(1000)
        assertEquals(1, a.used)
    }

    /** A killed process leaves its run open: the next start takes it back when it gained bytes, else keeps it. */
    @Test fun killedRunSettlesAtNextStart() {
        val open = Attempts().start(0)!!.end().start(10)!!
        assertEquals(2, open.used)
        assertEquals(2, open.start(500)!!.used) // gained: the open run is taken back, the new one counts
        assertEquals(3, open.start(10)!!.used) // no bytes: both count
        assertEquals(4, Attempts(4, 10).start(500)!!.used)
        assertEquals(5, Attempts(5, 10).start(500)!!.used)
        assertNull(Attempts(5, 10).start(10))
    }

    @Test fun memoryMark() {
        assertTrue(FileRules.markShowsMemoryError(1000, listOf(500, 1000)))
        assertTrue(!FileRules.markShowsMemoryError(1000, listOf(999)))
        assertTrue(!FileRules.markShowsMemoryError(1000, emptyList()))
    }

    private val fv = FileValue("https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-0123456789abcdef0123456789abcdef", 1795405632,
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", "report (1).pdf", 1234567, "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg")

    @Test fun fileMessageJson() {
        val json = InnerMessage.jsonOf(44, MessageBody.File(fv, "dG9wc2VjcmV0aWQxMjM0NQ"))
        assertEquals("{\"v\":1,\"n\":44,\"id\":\"dG9wc2VjcmV0aWQxMjM0NQ\",\"show\":true,\"file\":{\"url\":\"https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-0123456789abcdef0123456789abcdef\",\"expires\":1795405632,\"key\":\"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY\",\"name\":\"report (1).pdf\",\"size\":1234567,\"sha256\":\"n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg\"}}", json)
        assertEquals(44L to MessageBody.File(fv, "dG9wc2VjcmV0aWQxMjM0NQ"), InnerMessage.parseJson(json.toByteArray()))
        assertEquals(false, MessageBody.File(fv).isControl)
    }

    @Test fun fileMessageParse() {
        fun parse(file: String) = InnerMessage.parseJson("{\"n\":1,\"show\":true,\"file\":$file}".toByteArray())?.second
        val ok = fv.toJson()
        assertEquals(MessageBody.File(fv), parse(ok))
        // unknown fields are ignored; size 0 is a file
        assertEquals(MessageBody.File(fv), parse(ok.dropLast(1) + ",\"type\":\"x\"}"))
        assertEquals(MessageBody.File(fv.copy(size = 0)), parse(ok.replace("\"size\":1234567", "\"size\":0")))
        for (bad in listOf(
            "\"x\"", "1", "[]",
            ok.replace("\"size\":1234567", "\"size\":-1"), ok.replace("\"size\":1234567", "\"size\":1.5"), ok.replace("\"size\":1234567", "\"size\":01"),
            ok.replace("\"size\":1234567", "\"size\":9007199254740992"), ok.replace("\"size\":1234567", "\"size\":\"5\""), ok.replace(",\"size\":1234567", ""),
            ok.replace("\"expires\":1795405632", "\"expires\":null"), ok.replace("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", "MDEy"),
            ok.replace("n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg", "n4bQgYhMfWWaL+qgxVrQFaO_TxsrC4Is0V1sFbDwCgg"),
            ok.replace("\"name\":\"report (1).pdf\"", "\"name\":7"), ok.replace("\"name\":\"report (1).pdf\"", "\"name\":\"${"a".repeat(2049)}\""),
        )) assertNull(bad, parse(bad))
    }
}
