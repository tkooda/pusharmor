package com.pusharmor.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import com.pusharmor.protocol.ReplayWindow.Verdict.FRESH
import com.pusharmor.protocol.ReplayWindow.Verdict.SEEN
import com.pusharmor.protocol.ReplayWindow.Verdict.TOO_OLD

class ReplayWindowTest {
    @Test fun outOfOrderWithin100AndRepeats() {
        var w = ReplayWindow.fresh()
        for (n in listOf(5L, 3L, 4L, 1L, 2L)) { assertEquals(FRESH, w.check(n)); w = w.accept(n) }
        for (n in 1L..5L) assertEquals(SEEN, w.check(n))
        w = w.accept(105)
        assertEquals(TOO_OLD, w.check(5))
        assertEquals(TOO_OLD, w.check(4))
        assertEquals(FRESH, w.check(6))
        assertEquals(SEEN, w.check(105))
        w = w.accept(6)
        assertEquals(SEEN, w.check(6))
    }

    @Test fun bigJumpClears() {
        val w = ReplayWindow.fresh().accept(1).accept(2).accept(500)
        assertEquals(500L, w.h)
        assertEquals(FRESH, w.check(499))
        assertEquals(TOO_OLD, w.check(400))
        assertEquals(FRESH, w.check(401))
    }

    @Test fun blobRoundTrip() {
        var w = ReplayWindow.fresh()
        for (n in listOf(10L, 3L, 99L, 100L, 1L)) w = w.accept(n)
        val r = ReplayWindow.of(w.h, w.bitmapBytes())
        assertArrayEquals(w.bitmapBytes(), r.bitmapBytes())
        for (n in 1L..100L) assertEquals(w.check(n), r.check(n))
        assertEquals(13, w.bitmapBytes().size)
    }
}
