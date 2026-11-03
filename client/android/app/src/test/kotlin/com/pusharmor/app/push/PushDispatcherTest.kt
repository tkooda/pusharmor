package com.pusharmor.app.push

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A failing push and a failing notice together still do not crash. */
class PushDispatcherTest {
    @Test fun failingOnFailIsContained() {
        var tried = false
        PushDispatcher.guard({ tried = true; throw NullPointerException() }) { throw IllegalStateException() }
        assertTrue(tried)
    }

    /** The relay server's test push is recognized, so it is dropped with no notification; other pushes are not. */
    @Test fun checkPushIsRecognized() {
        assertTrue(PushDispatcher.isCheck(mapOf("check" to "1")))
        assertFalse(PushDispatcher.isCheck(mapOf("m" to "abc")))
        assertTrue(PushDispatcher.isCheck("{\"check\":1}"))
        assertFalse(PushDispatcher.isCheck("{\"probe\":\"x\"}"))
        assertFalse(PushDispatcher.isCheck("not json"))
    }
}
