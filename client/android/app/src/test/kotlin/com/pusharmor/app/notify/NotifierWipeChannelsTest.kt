package com.pusharmor.app.notify

import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A wipe deletes the messages and pairing channels it is about to forget, so no orphans stay in system settings. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class NotifierWipeChannelsTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val nm get() = app.getSystemService(NotificationManager::class.java)

    @Test fun mainChannelsAreDeleted() = runBlocking(Dispatchers.IO) {
        g.notifier.ensureChannels()
        val ids = listOf(Settings.K.CH_MESSAGES, Settings.K.CH_PEERS).map { g.settings.get(it)!! }
        ids.forEach { assertNotNull(nm.getNotificationChannel(it)) }
        g.notifier.deleteMainChannels()
        ids.forEach { assertNull(nm.getNotificationChannel(it)) }
        g.settings.clearKeepingOldId()
    }
}
