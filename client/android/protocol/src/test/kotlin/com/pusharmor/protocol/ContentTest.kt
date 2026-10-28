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

    @Test fun urlMatchesWhatwg() {
        fun href(s: String) = UrlCheck.parse(s)!!.href
        assertEquals("https://a.com/a|b", href("https://a.com/a|b"))
        assertEquals("https://a.com/a%7Bb%7D%22c", href("https://a.com/a{b}\"c"))
        assertEquals("http://my_host.com/", href("http://my_host.com/"))
        assertEquals("my_host.com", UrlCheck.parse("http://my_host.com/")!!.host)
        assertEquals("https://a.com/a%zz%2", href("https://a.com/a%zz%2"))
        assertEquals("https://a.com/b/c", href("https://a.com/a/../b/./c"))
        assertEquals("https://a.com/x/y", href("https://a.com\\x\\y"))
        assertEquals("https://a.com/%C3%A9?%C3%A9#%C3%A9", href("https://a.com/\u00e9?\u00e9#\u00e9"))
        assertEquals("https://a.com/?a|b^c{d}e%22f%3Cg%3Eh`i%27j", href("https://a.com/?a|b^c{d}e\"f<g>h`i'j"))
        assertEquals("https://a.com/#a|b^c{d}e%22f%3Cg%3Eh%60i'j", href("https://a.com/#a|b^c{d}e\"f<g>h`i'j"))
        assertEquals("https://a.com/", href("https://a.com:/"))
        assertEquals("http://a.com:81/", href("http://a.com:0081"))
        assertEquals("https://a.com/?x", href("https://a.com?x"))
        assertEquals("https://[::1]/", href("https://[::1]/"))
        assertNull(UrlCheck.parse("https://a.com:99999/"))
        assertNull(UrlCheck.parse("https://a|b.com/"))
        assertEquals(ContentType.URL, Detect.type("http://a.com/x y"))
        assertEquals("http://a.com/x%20y", href("http://a.com/x y"))
        assertEquals("https://xn--strae-oqa.de/", href("https://stra\u00dfe.de/"))
        assertEquals("https://xn--ab-m1t.com/", href("https://a\u200db.com/"))
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
