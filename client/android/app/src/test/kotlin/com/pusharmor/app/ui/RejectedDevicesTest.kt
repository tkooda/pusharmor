package com.pusharmor.app.ui

import com.pusharmor.protocol.Peer
import org.junit.Assert.assertEquals
import org.junit.Test

/** Reject takes a not-yet-paired device off the Devices list; a new pairing shows it again. */
class RejectedDevicesTest {
    private val ready = Peer(id = "a")
    private val rejected = Peer(id = "b", deniedByMe = true)
    private val paired = Peer(id = "c", signPub = "s", encPub = "e", pairingId = ByteArray(16))
    private val gone = Peer(id = "d", deniedByMe = true, removed = true)

    @Test fun rejectedRowIsHidden() {
        val all = listOf(ready, rejected, paired, gone)
        assertEquals(listOf("a", "c"), devicesShown(all, emptySet()).map { it.id })
    }

    @Test fun openPairingShowsTheRowAgain() {
        val all = listOf(ready, rejected)
        assertEquals(listOf("a", "b"), devicesShown(all, setOf("b")).map { it.id })
    }

    @Test fun rejectedSectionListsOnlyRejectedRows() {
        val all = listOf(ready, rejected, paired, gone)
        assertEquals(listOf("b"), devicesRejected(all, emptySet()).map { it.id })
        assertEquals(emptyList<String>(), devicesRejected(all, setOf("b")).map { it.id })
    }

    @Test fun pairedRowStaysAfterReject() {
        val p = paired.copy(deniedByMe = true)
        assertEquals(listOf("c"), devicesShown(listOf(p), emptySet()).map { it.id })
    }

    @Test fun halfDoneRowsWaitToPair() {
        assertEquals(true, waitingToPair(ready))
        assertEquals(false, waitingToPair(paired.copy(approved = true, approveVerified = true)))
        assertEquals(true, waitingToPair(paired.copy(approved = true)))
        assertEquals(true, waitingToPair(paired.copy(approved = true, approveVerified = true, listAfterVerify = true)))
        assertEquals(true, waitingToPair(paired.copy(declined = true)))
        assertEquals("Rejected devices (2)", rejectedHeader(2))
    }
}
