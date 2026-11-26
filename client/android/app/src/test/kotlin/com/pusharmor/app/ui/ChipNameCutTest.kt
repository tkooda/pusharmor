package com.pusharmor.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A send chip too narrow for "Name (907-331-064)" cuts the name, never the ID. */
class ChipNameCutTest {
    private fun fits(n: Int): (String) -> Boolean = { it.length <= n }

    @Test fun longNameKeepsWholeId() {
        val label = "Thor's very long Pixel 8 Pro phone (907-331-064)"
        val shown = UiText.keepIdCut(label, fits(30))
        assertTrue(shown, shown.endsWith(" (907-331-064)"))
        assertTrue(shown, shown.contains("..."))
        assertEquals(30, shown.length)
        assertTrue(shown.startsWith("Thor's"))
    }

    @Test fun quotedOrRemovedLabelKeepsWholeId() {
        val sent = UiText.keepIdCut("Sent to \"Thor's very long Pixel phone (907-331-064)\"", fits(36))
        assertTrue(sent, sent.endsWith(" (907-331-064)\""))
        assertTrue(sent, sent.startsWith("Sent to \"") && sent.contains("..."))
        val removed = UiText.keepIdCut("Thor's very long Pixel phone (907-331-064) (removed)", fits(40))
        assertTrue(removed, removed.endsWith(" (907-331-064) (removed)"))
        assertEquals(40, removed.length)
    }

    @Test fun sendTextsCutTheNameAndKeepTheId() {
        val x = "Thor's very long Pixel phone (907-331-064)"
        assertEquals("Send to \"Thor's very long... (907-331-064)\"", UiText.sendLabel(1, x))
        assertEquals("Sending to \"Thor's very long... (907-331-064)\"", UiText.sendingTo(x))
        assertEquals("Sent to \"Thor's very long... (907-331-064)\"", UiText.sentTitle(mapOf("a" to "sent")) { x })
        assertEquals("\u2022 Thor's very long... (907-331-064)", UiText.bulleted(x))
        assertEquals("Sending \"a.pdf\" to \"Thor's very long... (907-331-064)\"...", UiText.directSendingFile("a.pdf", listOf(x)))
    }

    @Test fun labelThatFitsOrHasNoIdIsUnchanged() {
        assertEquals("Pixel 8 (907-331-064)", UiText.keepIdCut("Pixel 8 (907-331-064)", fits(40)))
        val plain = "Thor's very long Pixel 8 Pro phone"
        assertEquals(plain, UiText.keepIdCut(plain, fits(10)))
    }
}
