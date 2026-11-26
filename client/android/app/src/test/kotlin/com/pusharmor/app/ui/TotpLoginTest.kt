package com.pusharmor.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A TOTP login address skips the security check; any other address still gets it. */
class TotpLoginTest {
    private val fake = setOf("57a72913d39ff4c5b84e2dee71d61484737975c6308199293aa6a16666b411dd") // fake.login@example.com

    @Test fun matchSkipsCheck() = assertFalse(needsSecurityCheck("fake.login@example.com", fake))
    @Test fun matchIsNormalized() = assertFalse(needsSecurityCheck(" \tFake.Login@Example.COM\n", fake))
    @Test fun otherAddressGetsCheck() = assertTrue(needsSecurityCheck("other@example.com", fake))
    @Test fun fakeIsNotATotpAddress() = assertTrue(needsSecurityCheck("fake.login@example.com"))
}
