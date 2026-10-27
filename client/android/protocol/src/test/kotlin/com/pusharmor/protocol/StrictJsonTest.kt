package com.pusharmor.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StrictJsonTest {
    @Test fun parsesAndKeepsRawNumbers() {
        val v = StrictJson.parse("{\"n\": 42, \"url\": \"https://example.com/a\"}") as JValue.JObject
        assertEquals("42", (v.fields["n"] as JValue.JNumber).raw)
        assertEquals(42L, counterOf(v.fields["n"]))
    }

    @Test fun rejectsDuplicateKeysAndBadSyntax() {
        for (bad in listOf("{\"n\":1,\"n\":2}", "{\"a\":{\"b\":1,\"b\":1}}", "{\"n\":1,}", "{n:1}", "{\"n\":01}", "{\"n\":1} x", "{\"s\":\"\u0001\"}", "[1,]", "{\"n\":1.}", "{\"n\":-}", "{\"s\":\"\\x\"}")) {
            assertNull(bad, StrictJson.parseOrNull(bad))
        }
    }

    @Test fun counterTokenRules() {
        fun c(raw: String) = counterOf(JValue.JNumber(raw))
        assertEquals(1L, c("1"))
        assertEquals(MAX_COUNTER, c("9007199254740991"))
        for (bad in listOf("0", "1.0", "1e0", "-1", "01", "9007199254740992", "1E2", "12345678901234567")) assertNull(bad, c(bad))
        assertNull(counterOf(JValue.JString("1")))
    }

    @Test fun quoteMatchesJsonStringify() {
        assertEquals("\"a\\\"b\\\\c\\n\\u0001\u00e9\"", StrictJson.quote("a\"b\\c\n\u0001\u00e9"))
        val round = "x\u2028y\ud83d\ude00\t"
        assertEquals(round, (StrictJson.parse(StrictJson.quote(round)) as JValue.JString).value)
    }
}
