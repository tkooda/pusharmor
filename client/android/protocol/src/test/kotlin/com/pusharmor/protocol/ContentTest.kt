package com.pusharmor.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentTest {
    @Test fun catalogPhoneVectors() {
        assertTrue(Phone.isPhone("+1 555-123-4567"))
        assertTrue(Phone.isPhone("(555) 123.4567"))
        assertFalse(Phone.isPhone("2026-10-24"))
        assertFalse(Phone.isPhone("10.0.0.1"))
        assertFalse(Phone.isPhone("123456"))
        assertTrue(Phone.isPhone("tel:+15551234567"))
        assertTrue(Phone.isPhone("\u00a0 5551234567 "))
        assertFalse(Phone.isPhone("1234567890123456")) // 16 digits
        assertFalse(Phone.isPhone("24.10.2026"))
        assertFalse(Phone.isPhone("555\u0661234567")) // non-ASCII digit
    }

    @Test fun detectionPrecedence() {
        assertEquals(ContentType.TEXT, Detect.type("tel:hello"))
        assertEquals(ContentType.TEXT, Detect.type("TEL:+15551234567"))
        assertEquals(ContentType.TEL, Detect.type("tel:+15551234567"))
        assertEquals(ContentType.TEXT, Detect.type("5551234567\u000B"))
        assertEquals(ContentType.URL, Detect.type("https://example.com"))
        assertEquals(ContentType.TEL, Detect.type("+1 555-123-4567"))
        assertEquals(ContentType.TEXT, Detect.type("hello https://example.com"))
        assertEquals(ContentType.TEXT, Detect.type("ftp://example.com"))
    }

    @Test fun strictUrl() {
        assertEquals("https://example.com/", UrlCheck.parse("HTTPS://Example.COM")!!.href)
        assertEquals("example.com", UrlCheck.parse("https://Example.COM:443/a?b#c")!!.host)
        assertEquals("http://example.com:8080/a?b#c", UrlCheck.parse("http://example.com:8080/a?b#c")!!.href)
        assertNull(UrlCheck.parse("https://user:pw@example.com/"))
        assertNull(UrlCheck.parse("javascript:alert(1)"))
        assertNull(UrlCheck.parse("https:///path"))
        assertNull(UrlCheck.parse("https://exa mple.com"))
        assertNull(UrlCheck.parse("mailto:a@b.com"))
    }

    @Test fun sizeCap() {
        val s = "\u00e9".repeat(1100) // 2200 bytes
        val t = SizeCap.truncateUtf8(s)
        assertEquals(2048, SizeCap.utf8Size(t))
        val e = "\ud83d\ude00".repeat(600) // 4 bytes each
        assertEquals(2048, SizeCap.utf8Size(SizeCap.truncateUtf8(e)))
        assertEquals(2045, SizeCap.utf8Size(SizeCap.truncateUtf8("a" + e)))
        assertTrue(SizeCap.isNearCap("a".repeat(1844)))
        assertFalse(SizeCap.isNearCap("a".repeat(1843)))
    }
}
