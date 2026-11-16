package com.pusharmor.app.notify

import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Notices show their whole text when expanded; a blocked "peers" channel means a notice cannot show. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class NotifierNoticeTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val nm get() = app.getSystemService(NotificationManager::class.java)

    private fun bigText(tag: String, id: Int) =
        nm.activeNotifications.first { it.tag == tag && it.id == id }.notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()

    @Test fun noticesShowTheReasonLine() {
        runBlocking(Dispatchers.IO) { g.notifier.ensureChannels() }
        val text = "Unable to send to \"Laptop\".\nIt is not paired with this device."
        g.notifier.notice(text)
        assertEquals(text, bigText(Notifier.TAG_NOTICE, Notifier.NOTICE_ID))
        g.notifier.peersNotice(text)
        assertEquals(text, bigText(Notifier.TAG_NOTICE, Notifier.UNDELIVERED_ID))
    }

    @Test fun blockedPeersChannelMeansNoNotice() {
        assertTrue(Notifier.noticeShows(true, NotificationManager.IMPORTANCE_DEFAULT))
        assertTrue(Notifier.noticeShows(true, null))
        assertFalse(Notifier.noticeShows(true, NotificationManager.IMPORTANCE_NONE))
        assertFalse(Notifier.noticeShows(false, NotificationManager.IMPORTANCE_DEFAULT))
    }
}
