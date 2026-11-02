package com.pusharmor.app.notify

import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.protocol.engine.PairNoticeKind
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Pairing in-progress and ready notices show for a UnifiedPush push as well as for an FCM push. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class AppEffectsTest {
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val nm = app.getSystemService(NotificationManager::class.java)

    private fun pairTexts() = nm.activeNotifications.filter { it.tag == Notifier.TAG_PAIR }
        .map { it.notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString() }.sorted()

    // Room refuses main-thread queries: the effects run on another thread.
    private fun onThread(block: () -> Unit) = Thread(block).apply { start(); join() }

    private fun noticesFor(fcm: Boolean): List<String> {
        app.graph.notifier.ensureChannels()
        onThread {
            val e = AppEffects(app.graph, fcm)
            e.pairNotice("peer", "pk-ready", PairNoticeKind.READY, null)
            e.pairNotice("peer", "pk-progress", PairNoticeKind.IN_PROGRESS, null)
        }
        return pairTexts()
    }

    @Test fun unifiedPushShowsInProgressAndReady() {
        assertEquals(listOf("Pairing fingerprint ready. Open PushArmor.", "Pairing with a device in progress. Open PushArmor."), noticesFor(fcm = false))
    }

    @Test fun fcmShowsInProgressAndReady() {
        assertEquals(listOf("Pairing fingerprint ready. Open PushArmor.", "Pairing with a device in progress. Open PushArmor."), noticesFor(fcm = true))
    }
}
