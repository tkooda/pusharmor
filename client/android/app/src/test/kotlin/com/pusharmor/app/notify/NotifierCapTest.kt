package com.pusharmor.app.notify

import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.ShownContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** At most 25 message notifications stay up; the oldest are cancelled, the group summary stays. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class NotifierCapTest {
    @Test fun onlyTheNewest25MessageNotificationsStay() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val nm = app.getSystemService(NotificationManager::class.java)
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        // Room refuses main-thread queries.
        Thread {
            for (id in 1L..30L) {
                notifier.content(id, "peer", ShownContent(ContentType.TEXT, "hello $id", null, null))
                Thread.sleep(2)
            }
        }.apply { start(); join() }
        val ids = nm.activeNotifications.filter { it.tag == Notifier.TAG_MSG && it.id >= 0 }.map { it.id }.sorted()
        assertEquals((6..30).toList(), ids)
        assertTrue(nm.activeNotifications.any { it.tag == Notifier.TAG_MSG && it.id < 0 })
    }
}
