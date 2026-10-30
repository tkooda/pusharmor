package com.pusharmor.app

import com.pusharmor.app.ui.UiText
import com.pusharmor.app.ui.UiText.Mark
import com.pusharmor.protocol.Peer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** Screen text rules: status priority, counter, send label, fingerprint label, days, middle ellipsis. */
class UiTextTest {
    private val pinned = Peer(id = "p", platform = "chrome", signPub = "s", encPub = "e", pairingId = ByteArray(16),
        approved = true, approveVerified = true)

    @Test fun statusPriority() {
        assertEquals(Mark.OFF to "(missing)", UiText.status(pinned.copy(missing = true, paused = true, reachable = false)))
        assertEquals(Mark.OFF to "Signed out", UiText.status(pinned.copy(paused = true, reachable = false)))
        assertEquals(Mark.OFF to "Unreachable", UiText.status(pinned.copy(reachable = false)))
        assertEquals(Mark.OK to "Connected", UiText.status(pinned))
        assertEquals(Mark.WAIT to "Has not approved this device", UiText.status(pinned.copy(approveVerified = false)))
    }

    @Test fun counterAndSendLabel() {
        assertEquals("39 / 2048", UiText.counter(39))
        assertEquals("2048 / 2048", UiText.counter(2048))
        assertEquals("Too long (2049 / 2048)", UiText.counter(2049))
        assertEquals("Send", UiText.sendLabel(0))
        assertEquals("Send to 1 device", UiText.sendLabel(1))
        assertEquals("Send to 2 devices", UiText.sendLabel(2))
    }

    @Test fun fingerprintIsReadPerCharacter() {
        assertEquals("Pairing fingerprint K, 7, Q, D", UiText.fingerprintLabel("K7QD"))
    }

    @Test fun dayLabels() {
        val utc = ZoneOffset.UTC
        val now = 1_760_000_000_000L
        assertEquals("Today", UiText.dayLabel(now - 60_000, now, utc))
        assertEquals("Yesterday", UiText.dayLabel(now - 86_400_000, now, utc))
        assertTrue(UiText.dayLabel(now - 3 * 86_400_000L, now, utc) !in setOf("Today", "Yesterday"))
        assertEquals("1 day", UiText.days(1))
        assertEquals("30 days", UiText.days(30))
    }

    @Test fun renameFieldError() {
        assertEquals(null, UiText.nameError("Phone"))
        assertEquals(null, UiText.nameError("x".repeat(32)))
        assertEquals("Use 1 to 32 plain ASCII characters.", UiText.nameError(""))
        assertEquals("Use 1 to 32 plain ASCII characters.", UiText.nameError("Caf\u00e9"))
        assertEquals("Use 1 to 32 plain ASCII characters.", UiText.nameError("x".repeat(33)))
    }

    @Test fun middleEllipsisKeepsStartAndEnd() {
        val url = "https://www.example.com/recipes/weeknight-lemon-pasta"
        assertEquals(url, UiText.middleEllipsis(url) { it.length <= 80 })
        val cut = UiText.middleEllipsis(url) { it.length <= 27 }
        assertEquals(27, cut.length)
        assertEquals(1, Regex("\\.\\.\\.").findAll(cut).count()) // one "..." only
        assertTrue(cut.startsWith("https://www.exa"))
        assertTrue(cut.endsWith("pasta"))
        assertEquals("...", UiText.middleEllipsis(url) { it.length <= 3 })
    }
}
