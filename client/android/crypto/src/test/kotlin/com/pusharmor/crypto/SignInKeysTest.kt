package com.pusharmor.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class SignInKeysTest {
    @Test fun repeatedCallsInOneAttemptReuseTheSameKeys() {
        var held: KeyOps? = null
        var created = 0
        val create = { created++; SoftwareKeyOps.generate() }
        val a = signInKeys(held, { null }, create) { held = it }
        val b = signInKeys(held, { null }, create) { held = it }
        assertEquals(1, created)
        assertArrayEquals(a.signPub, b.signPub)
    }

    @Test fun storedKeysAreReusedBeforeCreatingNew() {
        val stored = SoftwareKeyOps.generate()
        var created = 0
        val k = signInKeys(null, { stored }, { created++; SoftwareKeyOps.generate() }) { }
        assertEquals(0, created)
        assertArrayEquals(stored.signPub, k.signPub)
    }
}
