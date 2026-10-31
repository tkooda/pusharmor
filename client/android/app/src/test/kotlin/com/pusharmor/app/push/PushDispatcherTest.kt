package com.pusharmor.app.push

import org.junit.Assert.assertTrue
import org.junit.Test

/** A failing push and a failing notice together still do not crash (I551). */
class PushDispatcherTest {
    @Test fun failingOnFailIsContained() {
        var tried = false
        PushDispatcher.guard({ tried = true; throw NullPointerException() }) { throw IllegalStateException() }
        assertTrue(tried)
    }
}
