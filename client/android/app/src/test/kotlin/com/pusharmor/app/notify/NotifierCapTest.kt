package com.pusharmor.app.notify

import android.app.Notification
import android.app.NotificationManager
import android.service.notification.StatusBarNotification
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.ShownContent
import com.pusharmor.protocol.engine.Direction
import com.pusharmor.protocol.engine.HistoryRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowNotificationManager

/** At most 25 message notifications stay up; the oldest are cancelled, the group summary stays. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class, shadows = [NotifierCapTest.LaggingNotificationManager::class])
class NotifierCapTest {
    /** The active list leaves out the newest [hide] message posts, as the system list can lag a post. */
    @Implements(NotificationManager::class)
    class LaggingNotificationManager : ShadowNotificationManager() {
        companion object {
            @Volatile var hide = 0
            val recent = ArrayDeque<Int>()
        }

        @Implementation override fun notify(tag: String?, id: Int, notification: Notification) {
            super.notify(tag, id, notification)
            if (tag == Notifier.TAG_MSG && id >= 0) synchronized(recent) {
                recent.remove(id); recent.addLast(id)
                while (recent.size > hide) recent.removeFirst()
            }
        }

        @Implementation override fun getActiveNotifications(): Array<StatusBarNotification> = synchronized(recent) {
            super.getActiveNotifications().filter { !(it.tag == Notifier.TAG_MSG && it.id in recent) }.toTypedArray()
        }

        /** The real list, for the asserts. */
        fun all(): Array<StatusBarNotification> = super.getActiveNotifications()
    }

    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val nm = app.getSystemService(NotificationManager::class.java)

    private fun all() = Shadow.extract<LaggingNotificationManager>(nm).all()
    private fun messageIds() = all().filter { it.tag == Notifier.TAG_MSG && it.id >= 0 }.map { it.id }.sorted()

    private fun post(ids: LongRange) {
        for (id in ids) {
            app.graph.notifier.content(id, "peer", ShownContent(ContentType.TEXT, "hello $id", null, null))
            Thread.sleep(2)
        }
    }

    // Room refuses main-thread queries: posts run on another thread.
    private fun onThread(block: () -> Unit) = Thread(block).apply { start(); join() }

    @Test fun onlyTheNewest25MessageNotificationsStay() {
        LaggingNotificationManager.hide = 0
        app.graph.notifier.ensureChannels()
        onThread { post(1L..30L) }
        assertEquals((6..30).toList(), messageIds())
        assertTrue(all().any { it.tag == Notifier.TAG_MSG && it.id < 0 })
    }

    @Test fun aBurstTheActiveListLagsBehindStillLeavesAtMost25() {
        LaggingNotificationManager.hide = 3
        app.graph.notifier.ensureChannels()
        val a = Thread { post(1L..30L) }
        val b = Thread { post(101L..130L) }
        a.start(); b.start(); a.join(); b.join()
        LaggingNotificationManager.hide = 0
        assertEquals(25, messageIds().size)
    }

    @Test fun pairAndPeersNoticesAndHistoryStayWhenMessagesAreTrimmed() {
        LaggingNotificationManager.hide = 0
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        val pk = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
        var first = 0L
        onThread {
            notifier.pairNotice(pk, "pairing", null)
            notifier.peersNotice("peers")
            notifier.notice("notice")
            first = app.graph.store.insertHistory(HistoryRow(direction = Direction.RECEIVED, peerId = "peer", type = "text", content = "first", at = System.currentTimeMillis()))
            post(first..first + 30)
        }
        val all = all()
        assertTrue(all.any { it.tag == Notifier.TAG_PAIR && it.id == Notifier.pairId(pk) })
        assertTrue(all.any { it.tag == Notifier.TAG_NOTICE && it.id == Notifier.UNDELIVERED_ID })
        assertTrue(all.any { it.tag == Notifier.TAG_NOTICE && it.id == Notifier.NOTICE_ID })
        assertFalse(first.toInt() in messageIds())
        var kept: Any? = null
        onThread { kept = app.graph.dao.history(first) }
        assertNotNull(kept)
    }
}
