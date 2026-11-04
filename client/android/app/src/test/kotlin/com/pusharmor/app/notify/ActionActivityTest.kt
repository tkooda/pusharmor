package com.pusharmor.app.notify

import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.store.HistoryEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

/** A notification tap must not crash: the activity finishes after onResume. With no app for an action, a message shows. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class ActionActivityTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun tap(act: String, id: Long = 1L): ActionActivity {
        val ctx = ApplicationProvider.getApplicationContext<PaApp>()
        val i = Intent(ctx, ActionActivity::class.java).putExtra("history", id).putExtra("act", act)
        val a = Robolectric.buildActivity(ActionActivity::class.java, i).setup().get()
        val end = System.currentTimeMillis() + 5000
        while (!a.isFinishing && System.currentTimeMillis() < end) { Thread.sleep(20); idle() }
        return a
    }

    @Test fun tapFinishesWithoutCrash() {
        assertTrue(tap("item").isFinishing)
        // The tap opens History with its row id, to scroll to and flash.
        val next = shadowOf(ApplicationProvider.getApplicationContext<PaApp>()).nextStartedActivity
        assertEquals(1L, com.pusharmor.app.ui.MainActivity.flashExtra(next))
    }

    /** A tap on a damaged database opens the app, which shows the data screen, instead of crashing. */
    @Test fun tapOnCorruptDatabaseOpensTheApp() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        com.pusharmor.app.corruptDatabase(app)
        assertTrue(tap("open").isFinishing)
        assertEquals(com.pusharmor.app.ui.MainActivity::class.java.name, shadowOf(app).nextStartedActivity.component?.className)
    }

    private fun textRow(): Long {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        var id = 0L
        Thread { id = app.graph.dao.insertHistory(HistoryEntity(direction = "in", peerId = null, type = "text", content = "hello", n = null,
            pairingId = null, at = 0, read = false, results = "", count = 1)) }.apply { start(); join() }
        return id
    }

    private fun clipText(): String? = ApplicationProvider.getApplicationContext<PaApp>().getSystemService(android.content.ClipboardManager::class.java)
        .primaryClip?.getItemAt(0)?.text?.toString()

    /** Below Android 13 no system preview shows, so a Toast confirms the copy. */
    @Config(sdk = [32], application = TestApp::class)
    @Test fun copyBelowApi33ShowsCopied() {
        assertTrue(tap("copy", textRow()).isFinishing)
        assertEquals("hello", clipText())
        assertEquals("Copied", ShadowToast.getTextOfLatestToast())
    }

    /** Android 13 and later shows its own clipboard preview; the app adds nothing. */
    @Test fun copyOnApi33AndLaterShowsNoToast() {
        assertTrue(tap("copy", textRow()).isFinishing)
        assertEquals("hello", clipText())
        assertEquals(null, ShadowToast.getLatestToast())
    }

    @Test fun dialWithNoDialerShowsMessage() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        var id = 0L
        // Room refuses main-thread queries.
        Thread { id = app.graph.dao.insertHistory(HistoryEntity(direction = "in", peerId = null, type = "tel", content = "+15551234567", n = null,
            pairingId = null, at = 0, read = false, results = "", count = 1)) }.apply { start(); join() }
        shadowOf(app).checkActivities(true)
        assertTrue(tap("dial", id).isFinishing)
        assertEquals("No app can call this number.", ShadowToast.getTextOfLatestToast())
    }
}
