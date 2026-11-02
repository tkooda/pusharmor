package com.pusharmor.app

import com.pusharmor.app.ui.UiText
import com.pusharmor.app.ui.UiText.Mark
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.engine.PairStart as P
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** Screen text rules: status priority, counter, send label, send screen rules, fingerprint label, days, middle ellipsis. */
class UiTextTest {
    private val pinned = Peer(id = "p", platform = "chrome", signPub = "s", encPub = "e", pairingId = ByteArray(16),
        approved = true, approveVerified = true)

    @Test fun keysBrokenTexts() {
        assertEquals("This device's keys have become unusable.", UiText.KEYS_BROKEN_TITLE)
        assertEquals("Tap Retry to try again. If this keeps happening, you can delete the broken keys. You will then sign in again and pair all your devices again.", UiText.KEYS_BROKEN_BODY)
        assertEquals("Retry", UiText.KEYS_BROKEN_RETRY)
        assertEquals("Delete broken keys", UiText.KEYS_BROKEN_DELETE)
        assertEquals("Delete broken keys?", UiText.KEYS_BROKEN_DIALOG_TITLE)
        assertEquals("This cannot be undone. You will need to pair all your devices again.", UiText.KEYS_BROKEN_DIALOG_BODY)
    }

    /** The push service line names only the host: lower case, a-z 0-9 . - only, at most 64, never the path or token. */
    @Test fun pushHostIsSanitised() {
        assertEquals("push.example.com", UiText.pushHost("https://Push.Example.com/abc?x=1"))
        val long = "a".repeat(96) + ".com"
        assertEquals("a".repeat(64), UiText.pushHost("https://$long/secret-token"))
        assertEquals("up.example.org", UiText.pushHost("https://up.example.org:8443/wpush/v2/tok3n#frag"))
        assertEquals(null, UiText.pushHost(null))
        assertEquals(null, UiText.pushHost("not a url"))
        val shown = com.pusharmor.net.ErrorText.of(UiText.UNABLE_SEND, com.pusharmor.protocol.engine.ApiResult.Http(400, "push endpoint not allowed"),
            UiText.pushHost("https://Push.Example.com/abc?x=1"))
        assertEquals("Unable to send.\nThis device's push service is not supported yet.\n(push.example.com)", shown)
        assertTrue(!shown.contains("abc") && !shown.contains("x=1"))
    }

    /** A message file that could not be written says why. */
    @Test fun saveFileReason() {
        assertEquals("PushArmor is not allowed to save there. Choose another location.", UiText.saveReason(SecurityException("denied")))
        assertEquals("Storage is full. Free some space and try again.", UiText.saveReason(java.io.IOException("write failed: ENOSPC (No space left on device)")))
        assertEquals("Try again.", UiText.saveReason(java.io.IOException("no stream")))
    }

    /** One picked device that did not get the message: what failed on line 1, why on line 2. */
    @Test fun sendResultForOneDevice() {
        val to = "Unable to send to \"Laptop\".\n"
        assertEquals(null, UiText.sendResultText("sent", "Laptop"))
        assertEquals("Unable to deliver message to \"Laptop\".\nOpen PushArmor on it to resolve.", UiText.sendResultText("gone", "Laptop"))
        assertEquals(to + "That device is logged out. Log in on that device to receive messages.", UiText.sendResultText("logged out", "Laptop"))
        assertEquals(to + "It is set to send only. It does not receive messages.", UiText.sendResultText("not listening", "Laptop"))
        assertEquals(to + "It is not paired with this device. Pair with it to send it messages.", UiText.sendResultText("unapproved", "Laptop"))
        assertEquals(to + "It isn't paired with this device.", UiText.sendResultText("denied", "Laptop"))
        assertEquals(to + "It is no longer on this account.", UiText.sendResultText("unknown", "Laptop"))
        assertEquals(to + "Its push service did not accept the message. Try again later.", UiText.sendResultText("failed:410", "Laptop"))
        val notReady = to + "It has not finished turning on notifications. Open PushArmor on it."
        assertEquals(notReady, UiText.sendResultText("failed", "Laptop"))
        assertEquals(notReady, UiText.sendResultText("", "Laptop"))
        assertEquals(notReady, UiText.sendResultText("some new word", "Laptop"))
    }

    @Test fun cannotReceiveTruthTable() {
        assertEquals(false, UiText.cannotReceive(true, false, null))
        assertEquals(false, UiText.cannotReceive(true, false, "other"))
        assertEquals(true, UiText.cannotReceive(false, false, null))
        assertEquals(true, UiText.cannotReceive(true, true, null))
        assertEquals(true, UiText.cannotReceive(true, false, "no_distributor:x"))
    }

    @Test fun statusPriority() {
        assertEquals(Mark.OFF to "(missing)", UiText.status(pinned.copy(missing = true, loggedOut = true, reachable = false)))
        assertEquals(Mark.OFF to "Logged out", UiText.status(pinned.copy(loggedOut = true, reachable = false)))
        assertEquals(Mark.OFF to "Logged out", UiText.status(pinned.copy(loggedOut = true, listening = false)))
        assertEquals(Mark.OFF to "Send only", UiText.status(pinned.copy(listening = false, reachable = false)))
        assertEquals(Mark.OFF to "Unreachable", UiText.status(pinned.copy(reachable = false)))
        assertEquals(Mark.OK to "Paired", UiText.status(pinned))
        assertEquals(Mark.WAIT to "Unconfirmed", UiText.status(pinned.copy(approveVerified = false)))
        // A device that logged in but is not paired here yet (Pair and Reject row).
        val fresh = pinned.copy(signPub = null, encPub = null, pairingId = null, approved = false, approveVerified = false)
        assertEquals(Mark.WAIT to "Ready to pair", UiText.status(fresh))
        assertEquals(Mark.OFF to "Logged out", UiText.status(fresh.copy(loggedOut = true)))
    }

    @Test fun sendOnlyPeerIsNotInAllNorSelectable() {
        val ok = pinned.copy(id = "a", listApprovesMe = true, listAfterVerify = true)
        val cli = ok.copy(id = "c", platform = "cli", listening = false)
        assertTrue(ok.inAll)
        assertEquals(listOf("a"), com.pusharmor.protocol.allSet(listOf(ok, cli)).map { it.id })
        assertEquals(listOf("a"), UiText.sendable(listOf("c", "a"), listOf(ok, cli).filter { it.inAll }.map { it.id }))
    }

    @Test fun emailErrorClearsWhenValid() {
        val e = "Enter a valid email address."
        assertEquals(null, UiText.emailErrorAfterEdit(e, "a@b.com"))
        assertEquals(e, UiText.emailErrorAfterEdit(e, "a b@c"))
        assertEquals(e, UiText.emailErrorAfterEdit(e, "a@"))
        assertEquals(null, UiText.emailErrorAfterEdit(null, "a@"))
    }

    @Test fun shareTooLongIsSentence() {
        assertEquals("Unable to send.\nThe message is longer than 2048 characters.", UiText.SHARE_TOO_LONG)
    }

    @Test fun codeFieldState() {
        assertEquals("Code, 0 of 6 entered", UiText.codeState(0))
        assertEquals("Code, 4 of 6 entered", UiText.codeState(4))
    }

    @Test fun pairRefusedSaysWhy() {
        // one message per reason; none mentions being online, since pairing is not live.
        assertEquals(null, UiText.pairRefused(P.STARTED, "Pixel"))
        assertEquals("This device is no longer on your account.", UiText.pairRefused(P.NO_DEVICE, ""))
        assertEquals("Already paired with \"Pixel\".", UiText.pairRefused(P.PAIRED, "Pixel"))
        assertEquals("Pairing with \"Pixel\" is already in progress.", UiText.pairRefused(P.IN_PROGRESS, "Pixel"))
        assertEquals("\"Pixel\" can't pair right now. Open PushArmor on that device, then try again.", UiText.pairRefused(P.NOT_READY, "Pixel"))
        for (r in P.entries) assertTrue(UiText.pairRefused(r, "Pixel")?.contains("online") != true)
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
        // Same text as iOS.
        assertEquals("Message sent to \"Laptop\"", UiText.sendToast(1, 1, 3, "Laptop"))
        assertEquals("Message sent to 1 device", UiText.sendToast(1, 1, 3))
        assertEquals("Sent to 0 of 1 device", UiText.sendToast(1, 0, 1))
        assertEquals("Sent to 1 of 3 devices", UiText.sendToast(2, 1, 3))
        assertEquals("Message sent to 2 devices", UiText.sendToast(2, 2, 2))
        assertEquals("Message sent to 2 devices", UiText.sendToast(2, 2, 5))
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

    @Test fun limitRowText() {
        assertEquals("Trusts 0 devices. Trusted by 0.", UiText.limitRow(0, 0, reachable = true, loggedOut = false))
        assertEquals("Trusts 1 device. Trusted by 1.", UiText.limitRow(1, 1, reachable = true, loggedOut = false))
        assertEquals("Trusts 2 devices. Trusted by 2.", UiText.limitRow(2, 2, reachable = true, loggedOut = false))
        assertEquals("Trusts 2 devices. Trusted by 1. Unreachable. Logged out.", UiText.limitRow(2, 1, reachable = false, loggedOut = true))
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

    @Test fun emailFieldRedWhileNonEmptyAndInvalid() {
        assertEquals(false, UiText.emailFieldError(""))
        for (bad in listOf("a", "a@", "@b.com", "a@@b.com", "a b@c.com", "a@b,com", "j\u00f6@b.com", "<a@b.com>")) assertTrue(bad, UiText.emailFieldError(bad))
        for (ok in listOf("a@b.com", " a@b.com ", "A.B+tag@Example.COM", "x@privaterelay.appleid.com")) assertEquals(ok, false, UiText.emailFieldError(ok))
        assertEquals(false, UiText.emailValid("a".repeat(250) + "@b.com"))
    }

    @Test fun noPairedDeviceZeroWaitingAndAfterPairing() {
        // Devices shows the first-pair steps while this holds; the tabs always show.
        assertTrue(UiText.noPairedDevice(emptyList())) // zero devices
        val waiting = pinned.copy(id = "w", signPub = null, encPub = null, pairingId = null, approved = false, approveVerified = false)
        assertTrue(UiText.noPairedDevice(listOf(waiting))) // a device waiting to pair
        assertEquals(false, UiText.noPairedDevice(listOf(waiting, pinned))) // first pairing done
        assertTrue(UiText.noPairedDevice(listOf(pinned.copy(removed = true)))) // every paired device removed
        val copy = UiText.FIRST_DEVICE_TITLE + UiText.FIRST_DEVICE_STEPS.joinToString() + UiText.FIRST_DEVICE_WAITING
        assertEquals(false, copy.contains("peer", ignoreCase = true))
    }

    @Test fun emptyHistoryLeadsToPairingOrSend() {
        // no paired device leads to pairing, paired devices lead to Send, nothing before this device loads.
        assertEquals(UiText.EmptyCta.PAIR, UiText.historyCta(selfLoaded = true, paired = 0))
        assertEquals(UiText.EmptyCta.SEND, UiText.historyCta(selfLoaded = true, paired = 2))
        assertEquals(null, UiText.historyCta(selfLoaded = false, paired = 0))
        assertEquals("Pair your first device to start sending.", UiText.PAIR_FIRST_CTA)
        assertEquals("Messages you send or receive show here.", UiText.SEND_FIRST_CTA)
    }

    @Test fun renameInPlaceStartsCancelsSavesAndValidates() {
        val e = com.pusharmor.app.ui.NameEdit()
        e.start("Phone")
        // Editing starts with the whole name selected.
        assertTrue(e.editing)
        assertEquals(androidx.compose.ui.text.TextRange(0, 5), e.typed.selection)
        // Empty or too long: an error, and Save keeps editing and returns nothing.
        for (bad in listOf("", "x".repeat(33))) {
            e.typed = androidx.compose.ui.text.input.TextFieldValue(bad)
            assertTrue(e.error != null)
            assertEquals(null, e.save())
            assertTrue(e.editing)
        }
        e.cancel()
        assertEquals(false, e.editing)
        e.start("Phone"); e.typed = androidx.compose.ui.text.input.TextFieldValue("Kitchen")
        assertEquals(null, e.error)
        assertEquals("Kitchen", e.save())
        assertEquals(false, e.editing)
    }

    @Test fun hibernationBannerSaysWhyItMatters() {
        assertTrue(UiText.HIBERNATION_BANNER.contains("receive messages"))
        assertTrue(UiText.HIBERNATION_BANNER.contains("Manage app if unused"))
        assertTrue(UiText.HIBERNATION_BANNER.all { it.code < 128 })
    }

    @Test fun pairHowToStepsAreNumbered() {
        assertEquals(listOf("1. a", "2. b"), UiText.numbered(listOf("a", "b")))
        assertEquals(3, UiText.numbered(UiText.PAIR_HOWTO_STEPS).size)
    }

    @Test fun sendChipsSortByShownNameIgnoringCase() {
        val names = listOf("pixel", "Zed", "alpha", "Beta", "\u00c9clair", "Eagle")
        assertEquals(listOf("alpha", "Beta", "Eagle", "\u00c9clair", "pixel", "Zed"), UiText.sortedByName(names, { it }, java.util.Locale.US))
        assertEquals(listOf("a", "B", "c"), UiText.sortedByName(listOf("c", "B", "a"), { it }))
    }

    @Test fun sendWaitsOutCountdownOnlyForTheAddressJustSentTo() {
        val until = 1_000_000L + UiText.RESEND_MS
        assertEquals(42_000L, UiText.sendLeftMs(until, "sam@example.com", " Sam@Example.com ", 1_018_000L))
        assertEquals(0L, UiText.sendLeftMs(until, "sam@example.com", "sam@example.com", until))
        assertEquals(0L, UiText.sendLeftMs(until, "sam@example.com", "other@example.com", 1_018_000L))
        assertEquals(0L, UiText.sendLeftMs(0L, "", "sam@example.com", 1_018_000L))
    }

    @Test fun sendLabelCountsDownInWords() {
        assertEquals("Next", UiText.sendLabel("Next", 0))
        assertEquals("Next in 1 second", UiText.sendLabel("Next", 500))
        assertEquals("Next in 60 seconds", UiText.sendLabel("Next", 60_000))
        assertEquals("Next in 2 minutes", UiText.sendLabel("Next", 61_000))
    }
}
