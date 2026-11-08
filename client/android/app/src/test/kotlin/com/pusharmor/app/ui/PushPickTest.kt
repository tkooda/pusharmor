package com.pusharmor.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Picking Google again runs when no token was ever fetched, so a failed fetch can be retried. */
class PushPickTest {
    @Test fun rules() {
        assertFalse(pushPickRuns(PUSH_GOOGLE, PUSH_GOOGLE, "tok"))
        assertTrue(pushPickRuns(PUSH_GOOGLE, PUSH_GOOGLE, null))
        assertTrue(pushPickRuns(PUSH_GOOGLE, "org.app", "tok"))
        assertFalse(pushPickRuns("org.app", "org.app", null))
    }
}
