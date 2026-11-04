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

    @Test fun detectsTheType() {
        assertEquals(ContentType.TEXT, SendAsUrl.detected("hello"))
        assertEquals(ContentType.TEXT, SendAsUrl.detected(""))
        assertEquals(ContentType.URL, SendAsUrl.detected("minilock.org"))
        assertEquals(ContentType.TEL, SendAsUrl.detected("+15551234567"))
    }

    @Test fun urlWinsOverPhone() {
        // A URL with a phone-like path is a URL.
        assertEquals(ContentType.URL, SendAsUrl.detected("https://a.co/+15551234567"))
    }

    @Test fun textBoxOnlyForUrlOrPhone() {
        assertFalse(SendAsUrl.offersText("hello"))
        assertTrue(SendAsUrl.offersText("minilock.org"))
        assertTrue(SendAsUrl.offersText("+15551234567"))
    }

    @Test fun overrideSendsText() {
        assertEquals(ContentType.TEXT, SendAsUrl.effective("minilock.org", true))
        assertEquals(ContentType.URL, SendAsUrl.effective("minilock.org", false))
        assertEquals(ContentType.URL to "https://minilock.org", SendAsUrl.content(" minilock.org ", false))
        assertEquals(ContentType.TEXT to "minilock.org", SendAsUrl.content("minilock.org", true))
        assertEquals(ContentType.URL to "http://localhost", SendAsUrl.content("http://localhost", false))
        assertEquals(ContentType.TEL to "+15551234567", SendAsUrl.content(" +15551234567 ", false))
        assertEquals(ContentType.TEXT to " +15551234567 ", SendAsUrl.content(" +15551234567 ", true))
    }

    @Test fun overrideResetsWhenTheDetectedTypeChanges() {
        assertTrue(SendAsUrl.afterEdit("minilock.org", "minilock.org/x", true))
        assertFalse(SendAsUrl.afterEdit("minilock.org", "minilock.", true))
        assertFalse(SendAsUrl.afterEdit("minilock.org", "+15551234567", true))
        assertFalse(SendAsUrl.afterEdit("hello", "hello there", true))
        assertFalse(SendAsUrl.afterEdit("minilock.org", "minilock.org/x", false))
    }
}
