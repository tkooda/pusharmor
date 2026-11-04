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

/** A tapped message notification takes its group summary with it when it was the last one; a summary alone shows a blank notification. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class NotifierSummaryTest {
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val nm = app.getSystemService(NotificationManager::class.java)

    private fun messages() = nm.activeNotifications.filter { it.tag == Notifier.TAG_MSG }

    // Room refuses main-thread queries: posts run on another thread.
    private fun onThread(block: () -> Unit) = Thread(block).apply { start(); join() }

    private fun url(id: Long) = app.graph.notifier.content(id, "peer", ShownContent(ContentType.URL, "https://pusharmor.com/", "https://pusharmor.com/", "pusharmor.com"))

    @Test fun cancellingTheLastMessageAlsoCancelsTheSummary() {
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        onThread { url(1L) }
        assertEquals(2, messages().size)
        notifier.cancel(Notifier.TAG_MSG, 1)
        assertTrue(messages().isEmpty())
    }

    @Test fun aTapTheSystemAlreadyRemovedStillCancelsTheSummary() {
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        onThread { url(1L) }
        nm.cancel(Notifier.TAG_MSG, 1)
        notifier.cancel(Notifier.TAG_MSG, 1)
        assertTrue(messages().isEmpty())
    }

    @Test fun cancellingOneOfTwoMessagesKeepsTheSummary() {
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        onThread { url(1L); url(2L) }
        notifier.cancel(Notifier.TAG_MSG, 1)
        assertEquals(2, messages().size)
        assertTrue(messages().any { it.id == 2 })
        assertTrue(messages().any { it.id < 0 })
    }

    @Test fun historyClearsEveryMessageAndKeepsOtherNotices() {
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        onThread { url(1L); url(2L) }
        notifier.notice(Notifier.INVALID)
        notifier.pairNotice("AAAAAAAAAAAAAAAAAAAAAA", "pairing", null)
        notifier.cancelMessages()
        assertTrue(messages().isEmpty())
        assertEquals(setOf(Notifier.TAG_NOTICE, Notifier.TAG_PAIR), nm.activeNotifications.map { it.tag }.toSet())
    }
}
