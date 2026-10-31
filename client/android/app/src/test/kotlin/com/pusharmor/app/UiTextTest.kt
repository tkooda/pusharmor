package com.pusharmor.app

import com.pusharmor.app.ui.UiText
import com.pusharmor.app.ui.UiText.Mark
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Peer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** Screen text rules: status priority, counter, send label, send screen rules, fingerprint label, days, middle ellipsis. */
class UiTextTest {
    private val pinned = Peer(id = "p", platform = "chrome", signPub = "s", encPub = "e", pairingId = ByteArray(16),
        approved = true, approveVerified = true)

    @Test fun statusPriority() {
        assertEquals(Mark.OFF to "(missing)", UiText.status(pinned.copy(missing = true, loggedOut = true, reachable = false)))
        assertEquals(Mark.OFF to "Logged out", UiText.status(pinned.copy(loggedOut = true, reachable = false)))
        assertEquals(Mark.OFF to "Logged out", UiText.status(pinned.copy(loggedOut = true, listening = false)))
        assertEquals(Mark.OFF to "Send only", UiText.status(pinned.copy(listening = false, reachable = false)))
        assertEquals(Mark.OFF to "Unreachable", UiText.status(pinned.copy(reachable = false)))
        assertEquals(Mark.OK to "Paired", UiText.status(pinned))
        assertEquals(Mark.WAIT to "Has not approved this device", UiText.status(pinned.copy(approveVerified = false)))
    }

    @Test fun sendOnlyPeerIsNotInAllNorSelectable() {
        val ok = pinned.copy(id = "a", listApprovesMe = true, listAfterVerify = true)
        val cli = ok.copy(id = "c", platform = "cli", listening = false)
        assertTrue(ok.inAll)
        assertEquals(listOf("a"), com.pusharmor.protocol.allSet(listOf(ok, cli)).map { it.id })
        assertEquals(listOf("a"), UiText.sendable(listOf("c", "a"), listOf(ok, cli).filter { it.inAll }.map { it.id }))
    }

    @Test fun codeFieldState() {
        assertEquals("Code, 0 of 6 entered", UiText.codeState(0))
        assertEquals("Code, 4 of 6 entered", UiText.codeState(4))
    }

    @Test fun pairAgainNotice() {
        assertEquals("Chrome wants to pair again. Tap Pair again on its row.", UiText.pairAgainNotice("Chrome"))
    }

    @Test fun sendablePrunesDevicesThatCannotReceive() {
        // "b" turned logged out (left canReceive) and "x" is a preselect that never could receive.
        assertEquals(listOf("c", "a"), UiText.sendable(listOf("c", "b", "x", "a"), listOf("a", "c")))
        assertEquals(emptyList<String>(), UiText.sendable(listOf("b"), listOf("a")))
    }

    @Test fun rememberedSelection() {
        assertEquals(listOf("b", "c"), UiText.rememberedSelection("c,x,b", listOf("a", "b", "c")))
        assertEquals(emptyList<String>(), UiText.rememberedSelection(null, listOf("a")))
        assertEquals(emptyList<String>(), UiText.rememberedSelection("", listOf("a")))
        assertEquals(emptyList<String>(), UiText.rememberedSelection("x,y", listOf("a")))
    }

    @Test fun counterAndSendLabel() {
        assertEquals("39 / 2048", UiText.counter(39))
        assertEquals("2048 / 2048", UiText.counter(2048))
        assertEquals("Too long (2049 / 2048)", UiText.counter(2049))
        assertEquals("Send", UiText.sendLabel(0))
        assertEquals("Send to 1 device", UiText.sendLabel(1))
        assertEquals("Send to 2 devices", UiText.sendLabel(2))
        assertEquals("Send to \"Laptop\"", UiText.sendLabel(1, "Laptop"))
        assertEquals("Send to 2 devices", UiText.sendLabel(2, "Laptop"))
        assertEquals("Send to \"Android device ad...\"", UiText.sendLabel(1, "Android device added 2026-10-29"))
        assertEquals("Send to \"12345678901234567890\"", UiText.sendLabel(1, "12345678901234567890"))
    }

    @Test fun sentTitleNamesTheOneRecipient() {
        val names = mapOf("a" to "Laptop", "b" to "Android device added 2026-10-29")
        assertEquals("Sent to \"Laptop\"", UiText.sentTitle(mapOf("a" to "sent"), names::getValue))
        assertEquals("Sent to \"Android device ad...\"", UiText.sentTitle(mapOf("b" to "sent"), names::getValue))
        assertEquals("Sent", UiText.sentTitle(mapOf("a" to "sent", "b" to "sent"), names::getValue))
        assertEquals("Sent", UiText.sentTitle(mapOf("a" to "unreachable"), names::getValue))
        assertEquals("Sent", UiText.sentTitle(emptyMap(), names::getValue))
    }

    @Test fun sendScreenRules() {
        assertEquals("Send to (6 of 9)", UiText.sendToHeader(6, 9))
        assertEquals("Send to (0 of 1)", UiText.sendToHeader(0, 1))
        assertEquals(false, UiText.showAllChip(true, 1))
        assertEquals(true, UiText.showAllChip(true, 2))
        assertEquals(false, UiText.showAllChip(false, 5))
        assertEquals(false, UiText.showAllChip(true, 5, keyboardUp = true))
        assertEquals(true, UiText.chipVisible(selected = true, keyboardUp = true))
        assertEquals(false, UiText.chipVisible(selected = false, keyboardUp = true))
        assertEquals(true, UiText.chipVisible(selected = false, keyboardUp = false))
        assertEquals(true, UiText.chipVisible(selected = true, keyboardUp = false))
        // Keyboard up: the extra rows give way so the field keeps 2 lines (here 200 px); chips keep their space.
        assertEquals(true, UiText.sendExtrasShown(keyboardUp = true, areaPx = 500, chipsPx = 200, extrasPx = 100, fieldMinPx = 200))
        assertEquals(false, UiText.sendExtrasShown(keyboardUp = true, areaPx = 499, chipsPx = 200, extrasPx = 100, fieldMinPx = 200))
        assertEquals(false, UiText.sendExtrasShown(keyboardUp = true, areaPx = 300, chipsPx = 250, extrasPx = 100, fieldMinPx = 200))
        assertEquals(true, UiText.sendExtrasShown(keyboardUp = false, areaPx = 300, chipsPx = 250, extrasPx = 100, fieldMinPx = 200))
        assertEquals(false, UiText.showCounter(1843))
        assertEquals(true, UiText.showCounter(1844))
        assertEquals(true, UiText.showCounter(2049))
        assertEquals("Will open as a link", UiText.typeCaption(ContentType.URL))
        assertEquals("Will open as a phone number", UiText.typeCaption(ContentType.TEL))
        assertEquals("Will arrive as text", UiText.typeCaption(ContentType.TEXT))
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

    @Test fun logoutConfirmText() {
        assertEquals("Log out of this device? Keys, paired devices, names, and history stay on this device.", UiText.LOGOUT_CONFIRM)
    }

    @Test fun renameFieldError() {
        assertEquals(null, UiText.nameError("Phone"))
        assertEquals(null, UiText.nameError("x".repeat(32)))
        assertEquals("Use 1 to 32 plain ASCII characters, no double quotes.", UiText.nameError(""))
        assertEquals("Use 1 to 32 plain ASCII characters, no double quotes.", UiText.nameError("Caf\u00e9"))
        assertEquals("Use 1 to 32 plain ASCII characters, no double quotes.", UiText.nameError("x".repeat(33)))
        assertEquals("Use 1 to 32 plain ASCII characters, no double quotes.", UiText.nameError("My \"phone\""))
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

    @Test fun sendWithNoPairedDeviceShowsPairingGuidance() {
        assertTrue(UiText.noDevicesShown(selfLoaded = true, paired = 0))
        assertEquals(false, UiText.noDevicesShown(selfLoaded = true, paired = 1))
        assertEquals(false, UiText.noDevicesShown(selfLoaded = false, paired = 0)) // no flash before the store loads
        val copy = UiText.NO_DEVICES_TITLE + " " + UiText.NO_DEVICES_BODY
        assertTrue(copy.contains("Install PushArmor") && copy.contains("same account") && copy.contains("Tap Pair"))
        assertEquals(false, copy.contains("peer", ignoreCase = true))
    }
}
