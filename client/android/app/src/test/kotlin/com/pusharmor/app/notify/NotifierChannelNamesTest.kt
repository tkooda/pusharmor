package com.pusharmor.app.notify

import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.protocol.Peer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Notification channels are named as the app names the device, follow renames, and sit in one group. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class NotifierChannelNamesTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val nm get() = app.getSystemService(NotificationManager::class.java)

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private fun paired(id: String, name: String?) = Peer(id = id, platform = "android", signPub = "s", encPub = "e", pairingId = ByteArray(16),
        approved = true, approveVerified = true, name = name, created = 1_762_257_600L) // 2025-11-04 12:00 UTC: Nov 4 in nearly every time zone

    @After fun done() = io { g.store.wipeRegistration(); g.settings.clearKeepingOldId() }

    private fun channelName(peerId: String) = nm.getNotificationChannel(io { g.dao.peer(peerId)!!.channelId!! })!!.name.toString()

    @Test fun fixedChannelsAreRenamed() {
        io { g.notifier.ensureChannels() }
        assertEquals("Not used", nm.getNotificationChannel(Notifier.DEFAULT_CHANNEL).name.toString())
        assertEquals("Pairing and device changes", nm.getNotificationChannel(g.notifier.peersChannel).name.toString())
    }

    @Test fun deviceChannelsUseTheDisplayNameInOneGroup() {
        io { g.notifier.ensureChannels(); g.store.putPeer(paired("a", "Laptop")); g.notifier.createPeerChannel("a") }
        assertEquals("Laptop", channelName("a"))
        val ch = nm.getNotificationChannel(io { g.dao.peer("a")!!.channelId!! })
        assertEquals(Notifier.PEER_GROUP, ch.group)
        assertEquals("Messages from devices", nm.getNotificationChannelGroup(Notifier.PEER_GROUP).name.toString())
    }

    @Test fun unnamedDeviceUsesTheAddedFallback() {
        io { g.notifier.ensureChannels(); g.store.putPeer(paired("b", null)); g.notifier.createPeerChannel("b") }
        assertEquals("Android device added Nov 4", channelName("b"))
    }

    @Test fun listRefreshRenamesChannels() {
        io { g.notifier.ensureChannels(); g.store.putPeer(paired("a", "Laptop")); g.notifier.createPeerChannel("a") }
        val id = io { g.dao.peer("a")!!.channelId }
        io { g.store.putPeer(g.store.peer("a")!!.copy(name = "Desk")); g.session.updateShortcuts() }
        assertEquals("Desk", channelName("a"))
        assertEquals(id, io { g.dao.peer("a")!!.channelId })
        assertNotNull(nm.getNotificationChannel(id))
    }
}
