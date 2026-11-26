package com.pusharmor.app.ui

import com.pusharmor.protocol.Peer
import com.pusharmor.store.HistoryEntity
import org.junit.Assert.assertEquals
import org.junit.Test

/** A name gets its ID only when another device shown in the same place has the same name. */
class NameClashScopeTest {
    private val selfId = "s".repeat(40)
    private val pixel = Peer(id = "a".repeat(40), platform = "android", name = "Pixel 8")
    private val removedPixel = Peer(id = "b".repeat(40), platform = "android", name = "Pixel 8", removed = true)
    private val rejectedPixel = Peer(id = "c".repeat(40), platform = "android", name = "pixel 8", deniedByMe = true)
    private val ownPixel = Peer(id = selfId, platform = "android", name = "Pixel 8")
    private val laptop = Peer(id = "d".repeat(40), platform = "chrome", name = "Laptop")

    private fun row(peerId: String?, results: String = "{}") =
        HistoryEntity(direction = if (peerId == null) "SENT" else "RECEIVED", peerId = peerId, type = "text", content = "x", n = null,
            pairingId = null, at = 0L, read = true, results = results, count = 1)

    @Test fun sendNamesClashOnlyWithListedDevices() {
        val all = listOf(pixel, removedPixel, rejectedPixel, ownPixel, laptop)
        val listed = listedPeers(all, selfId, emptySet())
        assertEquals("Pixel 8", UiText.distinctLabel(pixel, listed))
        // A removed device still pairing is on the Devices list, so its name clashes.
        val pairing = listedPeers(all, selfId, setOf(removedPixel.id))
        assertEquals("Pixel 8 (${UiText.shortDeviceId(pixel.id)})", UiText.distinctLabel(pixel, pairing))
    }

    @Test fun historyNamesClashOnlyWithDevicesInHistory() {
        val all = listOf(pixel, removedPixel, laptop)
        assertEquals("Pixel 8", UiText.distinctLabel(pixel, historyPeers(all, listOf(row(pixel.id), row(laptop.id)))))
        // A sent row names the devices it went to.
        val sent = row(null, "{\"${removedPixel.id}\":\"sent\"}")
        assertEquals("Pixel 8 (${UiText.shortDeviceId(pixel.id)})", UiText.distinctLabel(pixel, historyPeers(all, listOf(row(pixel.id), sent))))
    }
}
