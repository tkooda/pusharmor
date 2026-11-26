package com.pusharmor.app.ui

import com.pusharmor.protocol.Peer
import com.pusharmor.store.HistoryEntity
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A paired device gets its ID only when another paired device has the same name; a device not paired (rejected,
 * waiting to pair, or removed but still in History) whose name clashes gets the ID, never the paired device. The own device never counts.
 */
class NameClashScopeTest {
    private val selfId = "s".repeat(40)
    private fun paired(id: String, name: String) = Peer(id = id, platform = "android", name = name, signPub = "s", encPub = "e",
        pairingId = byteArrayOf(1), approved = true, approveVerified = true)
    private val pixel = paired("a".repeat(40), "Pixel 8")
    private val otherPixel = paired("e".repeat(40), "pixel 8")
    private val removedPixel = Peer(id = "b".repeat(40), platform = "android", name = "Pixel 8", removed = true)
    private val rejectedPixel = Peer(id = "c".repeat(40), platform = "android", name = "pixel 8", deniedByMe = true)
    private val waitingPixel = Peer(id = "f".repeat(40), platform = "android", name = "Pixel 8")
    private val ownPixel = Peer(id = selfId, platform = "android", name = "Pixel 8")
    private val laptop = paired("d".repeat(40), "Laptop")

    private fun row(peerId: String?, results: String = "{}") =
        HistoryEntity(direction = if (peerId == null) "SENT" else "RECEIVED", peerId = peerId, type = "text", content = "x", n = null,
            pairingId = null, at = 0L, read = true, results = results, count = 1)
    private fun withId(p: Peer) = "${UiText.peerLabel(p.name, p.platform)} (${UiText.shortDeviceId(p.id)})"

    @Test fun pairedAndPairedBothGetIds() {
        val listed = listedPeers(listOf(pixel, otherPixel, laptop, ownPixel), selfId, emptySet())
        assertEquals(withId(pixel), UiText.distinctLabel(pixel, listed))
        assertEquals(withId(otherPixel), UiText.distinctLabel(otherPixel, listed))
        assertEquals("Laptop", UiText.distinctLabel(laptop, listed))
    }

    @Test fun pairedAndRejectedOnlyRejectedGetsId() {
        // Listed while a new pairing with it is open, and left out of the list otherwise.
        for (open in listOf(setOf(rejectedPixel.id), emptySet())) {
            val listed = listedPeers(listOf(pixel, rejectedPixel, ownPixel), selfId, open)
            assertEquals("Pixel 8", UiText.distinctLabel(pixel, listed))
            assertEquals(withId(rejectedPixel), UiText.distinctLabel(rejectedPixel, listed))
        }
        val listed = listedPeers(listOf(pixel, waitingPixel), selfId, emptySet())
        assertEquals("Pixel 8", UiText.distinctLabel(pixel, listed))
        assertEquals(withId(waitingPixel), UiText.distinctLabel(waitingPixel, listed))
    }

    @Test fun pairedAndRemovedInHistoryOnlyRemovedGetsId() {
        val all = listOf(pixel, removedPixel, laptop, ownPixel)
        val sent = row(null, "{\"${removedPixel.id}\":\"sent\"}")
        val named = historyPeers(all, selfId, listOf(row(pixel.id), sent))
        assertEquals("Pixel 8", UiText.distinctLabel(pixel, named))
        assertEquals(withId(removedPixel), UiText.distinctLabel(removedPixel, named))
        // A paired device clashes with another paired device even when only one of them is in History.
        val both = historyPeers(listOf(pixel, otherPixel), selfId, listOf(row(pixel.id)))
        assertEquals(withId(pixel), UiText.distinctLabel(pixel, both))
    }

    @Test fun noClashNoId() {
        val all = listOf(pixel, laptop, ownPixel)
        assertEquals("Pixel 8", UiText.distinctLabel(pixel, listedPeers(all, selfId, emptySet())))
        assertEquals("Pixel 8", UiText.distinctLabel(pixel, historyPeers(all, selfId, listOf(row(pixel.id), row(laptop.id)))))
        assertEquals("Laptop", UiText.distinctLabel(laptop, historyPeers(all, selfId, listOf(row(laptop.id)))))
    }
}
