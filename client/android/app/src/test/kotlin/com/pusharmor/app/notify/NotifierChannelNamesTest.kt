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
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    /** A device channel an earlier version made outside the group moves into it under a new id, with the user's importance, sound, vibration, and lights. */
    @Test fun ungroupedChannelMovesIntoTheGroup() {
        val pattern = longArrayOf(0, 100, 50, 100)
        io {
            g.notifier.ensureChannels()
            g.store.putPeer(paired("a", "Laptop"))
            nm.createNotificationChannel(android.app.NotificationChannel("old", "Laptop", NotificationManager.IMPORTANCE_LOW).also {
                it.setSound(null, null); it.vibrationPattern = pattern; it.enableLights(true); it.lightColor = 0xFF00FF00.toInt()
            })
            g.dao.setChannelId("a", "old")
            g.notifier.syncPeerChannels()
        }
        val id = io { g.dao.peer("a")!!.channelId!! }
        assertNotEquals("old", id)
        assertNull(nm.getNotificationChannel("old"))
        val ch = nm.getNotificationChannel(id)
        assertEquals(Notifier.PEER_GROUP, ch.group)
        assertEquals("Laptop", ch.name.toString())
        assertEquals(NotificationManager.IMPORTANCE_LOW, ch.importance)
        assertNull(ch.sound)
        assertTrue(ch.shouldVibrate())
        assertArrayEquals(pattern, ch.vibrationPattern)
        assertTrue(ch.shouldShowLights())
        assertEquals(0xFF00FF00.toInt(), ch.lightColor)
        // a second sync keeps the grouped channel
        io { g.notifier.syncPeerChannels() }
        assertEquals(id, io { g.dao.peer("a")!!.channelId })
    }
}
