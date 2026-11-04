package com.pusharmor.app.ui

import com.pusharmor.protocol.ContentType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The likely URL rule (the same on every client) and the "Send as URL" checkbox states. */
class SendAsUrlTest {
    @Test fun likelyUrls() {
        for (t in listOf("minilock.org", "  minilock.org  ", "https://minilock.org", "HTTP://a.b.co/x?y#z", "sub.example.com:8080/path",
            "example.com/", "xn--bcher-kva.xn--p1ai", "https://1.2.3.4", "http://localhost:8080/x")) assertTrue(t, LikelyUrl.check(t))
    }

    @Test fun notLikelyUrls() {
        for (t in listOf("minilock.", "minilockorg", "minilock.;org", "minilock .org", "", "   ", "a..com", "-a.com", "1.2.3.4",
            "hello world.com", "localhost", "ftp://x.com", "https://", "HTTP://", "https:// x", "a.com:", "a.com:8x", "a-.com", "a.c", "a.co1",
            "example.com.", "${"a".repeat(64)}.com")) assertFalse(t, LikelyUrl.check(t))
        assertTrue(LikelyUrl.check("${"a".repeat(63)}.com"))
    }

    @Test fun sentUrlIsTrimmedWithAScheme() {
        assertEquals("https://minilock.org", LikelyUrl.asUrl("  minilock.org \n"))
        assertEquals("http://a.b.co/x", LikelyUrl.asUrl("http://a.b.co/x"))
        assertEquals("HTTPS://a.co", LikelyUrl.asUrl("HTTPS://a.co"))
    }

    @Test fun startsUncheckedAndDisabled() {
        val s = SendAsUrl.start("")
        assertFalse(s.checked)
        assertFalse(SendAsUrl.enabled(""))
        assertTrue(SendAsUrl.start("minilock.org").checked) // a shared URL starts checked
    }

    @Test fun followsTheTextUntilTheUserUnchecks() {
        var s = SendAsUrl.start("")
        s = s.onText("minilock")
        assertFalse(s.checked)
        s = s.onText("minilock.org")
        assertTrue(s.checked)
        assertTrue(SendAsUrl.enabled("minilock.org"))
        s = s.onText("minilock.org is")
        assertFalse(s.checked)
        assertFalse(SendAsUrl.enabled("minilock.org is"))
        s = s.onText("minilock.org")
        assertTrue(s.checked)
        // The user unchecks: it never checks itself again for this message, it only gets enabled.
        s = s.onToggle(false)
        assertFalse(s.checked)
        s = s.onText("minilock.or").onText("minilock.org")
        assertFalse(s.checked)
        s = s.onText("minilock.").onText("minilock.org")
        assertFalse(s.checked)
        // A manual check still works.
        s = s.onToggle(true)
        assertTrue(s.checked)
    }

    @Test fun emptyFieldOrASendStartsOver() {
        var s = SendAsUrl.start("minilock.org").onToggle(false)
        s = s.onText("").onText("minilock.org")
        assertTrue(s.checked)
        s = s.onToggle(false)
        assertTrue(SendAsUrl.start("minilock.org").checked) // the state after a send
        assertFalse(s.onText("minilock.org").checked)
    }

    @Test fun sendCarriesUrlPhoneOrText() {
        assertEquals(ContentType.URL to "https://minilock.org", SendAsUrl.content(" minilock.org ", asUrl = true, asText = false))
        assertEquals(ContentType.TEXT to "minilock.org", SendAsUrl.content("minilock.org", asUrl = false, asText = false))
        assertEquals(ContentType.TEXT to "http://localhost", SendAsUrl.content("http://localhost", asUrl = false, asText = false)) // the user unchecked it
        assertTrue(SendAsUrl.start("http://localhost:8080/x").checked)
        assertEquals(ContentType.TEL to "+15551234567", SendAsUrl.content(" +15551234567 ", asUrl = false, asText = false))
        assertEquals(ContentType.TEXT to " +15551234567 ", SendAsUrl.content(" +15551234567 ", asUrl = false, asText = true))
        assertFalse(LikelyUrl.check("+15551234567") || LikelyUrl.check("tel:+15551234567"))
    }
}
