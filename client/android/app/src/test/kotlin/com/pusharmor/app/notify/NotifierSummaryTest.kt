package com.pusharmor.app.notify

import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.ShownContent
import com.pusharmor.store.PeerEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import android.app.Notification
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

    // The title is the sender's device name in quotes; the body is the message text or URL.
    @Test fun aMessageShowsTheSenderNameOverTheText() {
        val notifier = app.graph.notifier
        notifier.ensureChannels()
        onThread {
            app.graph.dao.putPeer(PeerEntity(
                id = "a".repeat(40), platform = "firefox", created = 1, listSignPub = null, listEncPub = null,
                signPub = "B".repeat(87), encPub = "C".repeat(87), pairingId = ByteArray(16), approved = true, deniedByMe = false,
                approveVerified = true, listApprovesMe = true, listDeniesMe = false, listAfterVerify = true, declined = false,
                reachable = true, loggedOut = false, logoutN = 0, hidden = false, name = "Firefox mobile", nameN = 1, removed = false, missing = false,
                lastN = 0, channelId = null, storedApprove = null, storedApproveName = null, lastApproveResult = null, lastSendAt = 0, note = null,
            ))
            notifier.content(1L, "a".repeat(40), ShownContent(ContentType.URL, "https://pusharmor.com/", "https://pusharmor.com/", "pusharmor.com"))
            notifier.content(2L, "a".repeat(40), ShownContent(ContentType.TEXT, "hello there", null, null))
            notifier.content(3L, "unknown", ShownContent(ContentType.TEXT, "who sent this", null, null))
        }
        fun shown(id: Int) = messages().first { it.id == id }.notification.extras.let {
            it.getCharSequence(Notification.EXTRA_TITLE).toString() to it.getCharSequence(Notification.EXTRA_TEXT).toString()
        }
        assertEquals("\"Firefox mobile\"" to "https://pusharmor.com/", shown(1))
        assertEquals("\"Firefox mobile\"" to "hello there", shown(2))
        assertEquals("Unknown sender" to "who sent this", shown(3))
    }
}
