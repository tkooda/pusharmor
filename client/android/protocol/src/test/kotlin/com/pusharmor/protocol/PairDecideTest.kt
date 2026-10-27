package com.pusharmor.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

/** Extra cases beside the golden pair_decide section. */
class PairDecideTest {
    private val low = ByteArray(30) { 0x10 }
    private val high = ByteArray(30) { 0x10 }.also { it[5] = 0x90.toByte() }
    private val c1 = ByteArray(32) { 1 }
    private val now = 1_761_300_000L

    private fun input(entry: PairEntryView? = null, listed: Listed = Listed.YES, pinned: Boolean = false) =
        CommitInput(low, high, c1, entry, pinned, false, false, null, false, listed, 0, emptyList(), now)

    @Test fun unlistedFetchesFirst() {
        assertEquals(PairAction.FETCH, PairDecide.commit(input(listed = Listed.NOT_FETCHED)).action)
        assertEquals(PairAction.DROP, PairDecide.commit(input(listed = Listed.NO)).action)
    }

    @Test fun signedByteOrderIsNotUsed() {
        // 0x90 is negative as a signed Kotlin Byte; unsigned it is higher, so low stays N.
        val n = PairEntryView(PairRole.N, PairState.COMMITTED, null, false)
        assertEquals(PairNotice.CROSSING, PairDecide.commit(input(entry = n)).notice)
    }
}
