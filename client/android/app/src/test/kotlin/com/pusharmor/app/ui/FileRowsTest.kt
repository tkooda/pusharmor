@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package com.pusharmor.app.ui

import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.ui.theme.PushArmorTheme
import com.pusharmor.app.data.Settings
import com.pusharmor.app.files.FileState
import com.pusharmor.app.files.ReceivedFiles
import com.pusharmor.protocol.FileRules.FinalCode
import com.pusharmor.protocol.FileValue
import com.pusharmor.store.HistoryEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/** File rows (Download with the expiry, memory error with Decrypt, Expired, image and file actions) and the Files settings. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class, qualifiers = "w411dp-h2400dp")
class FileRowsTest {
    // The screen runs on its own recomposer and frame clock, so frames do not depend on what earlier tests left behind.
    private val clock = BroadcastFrameClock()
    private val scope = CoroutineScope(Dispatchers.Main + clock)
    private val recomposer = Recomposer(scope.coroutineContext)

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    /** Frames of 16 ms, each with its state changes, recomposition, and layout, as on a device. */
    private fun frames(v: View, n: Int = 1) = repeat(n) {
        Snapshot.sendApplyNotifications()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
        clock.sendFrame(SystemClock.uptimeMillis() * 1_000_000)
        shadowOf(Looper.getMainLooper()).idle()
        roots(v).forEach { it.measureAndLayoutForTest() }
    }

    /** 43 chars of b64url (32 bytes 0..31). */
    private val key43 = com.pusharmor.crypto.B64url.encode(ByteArray(32) { it.toByte() })

    /** A 1 x 1 PNG. */
    private val png = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", 0)

    private fun texts(v: android.view.View) = nodes(v).map { text(it) }

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit, until: (List<String>) -> Boolean): Pair<org.robolectric.android.controller.ActivityController<ComponentActivity>, android.view.View> {
        scope.launch { recomposer.runRecomposeAndApplyChanges() }
        val c = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val view = ComposeView(c.get()).apply { setParentCompositionContext(recomposer) }
        c.get().setContentView(view)
        view.setContent { PushArmorTheme(dark = false) { content() } }
        val v = c.get().window.decorView
        val end = System.currentTimeMillis() + 10_000
        while (!until(texts(v)) && System.currentTimeMillis() < end) { Thread.sleep(20); frames(v) }
        return c to v
    }

    private fun close(c: org.robolectric.android.controller.ActivityController<ComponentActivity>) {
        c.pause().stop().destroy()
        recomposer.cancel()
        scope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test fun fileRows() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val now = System.currentTimeMillis()
        val g = app.graph
        runBlocking(Dispatchers.IO) {
            // WorkManager outlives one test: no file job of an earlier test may write here
            androidx.work.WorkManager.getInstance(app).cancelAllWork().result.get()
            app.graph.fileStore.root.deleteRecursively()
            // pickers Off, so no download job starts
            g.settings.set(Settings.K.FILE_WIFI, 0L)
            g.settings.set(Settings.K.FILE_MOBILE, 0L)
            fun row(name: String, i: Int, state: FileState?, plain: ByteArray? = null): Long {
                val id = g.dao.insertHistory(HistoryEntity(direction = "RECEIVED", peerId = null, type = "file",
                    content = FileValue("https://b2file.pusharmor.com/v1/x", now / 1000 + 2 * 3600 - 60, key43, name, 2_100_000, key43).toJson(),
                    n = null, pairingId = null, at = now - i * 1000L, read = true, results = "", count = 1))
                val k = ReceivedFiles.key(id)
                if (plain != null) { g.fileStore.outDir(k).mkdirs(); java.io.File(g.fileStore.outDir(k), name).writeBytes(plain) }
                state?.let { g.fileStore.put(k, it) }
                return id
            }
            row("pending.pdf", 0, null)
            row("memory.jpg", 1, FileState(downloaded = true, memoryError = true))
            row("old.txt", 2, FileState(code = FinalCode.EXPIRED, text = "Expired"))
            row("photo.png", 3, FileState(plain = "photo.png"), png)
            row("report.pdf", 4, FileState(plain = "report.pdf"), byteArrayOf(37, 80, 68, 70))
        }
        val vm = AppViewModel(app)
        val (c, v) = show({ HistoryScreen(vm) }) { t -> "View" in t && "Open" in t && "Decrypt" in t && "Download" in t }
        val t = texts(v)
        assertTrue(t.toString() + vm.files.rows.value, "Download" in t)
        assertTrue(t.toString(), "expires in 2 h" in t)
        assertTrue(t.toString(), "2.1 MB - PDF" in t)
        assertTrue("Not enough memory to decrypt" in t)
        assertTrue("Decrypt" in t)
        assertTrue(t.toString(), "Expired" in t)
        // an image: View, Copy, Share, Save; any other file: Open, Share, Save; no expiry once downloaded
        assertEquals(listOf(1, 1, 1, 2, 2), listOf("View", "Copy", "Open", "Share", "Save").map { w -> t.count { it == w } })
        assertEquals(1, t.count { it.startsWith("expires in") })
        vm.files.setShown(false)
        close(c)
    }

    @Test fun filesSettings() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        runBlocking(Dispatchers.IO) { app.graph.settings.set(Settings.K.FILE_WIFI, null); app.graph.settings.set(Settings.K.FILE_MOBILE, null) }
        val vm = AppViewModel(app)
        val (c, v) = show({ SettingsScreen(vm, onDeleteAccount = {}, onSignedOut = {}) }) { t -> "On mobile data" in t }
        val t = texts(v)
        val helper = t.indexOf("Larger files expire sooner, between 1 and 24 hours after they are sent")
        assertTrue(t.toString(), helper >= 0)
        // the helper text sits above both pickers; both default to Up to 50 MB
        assertTrue(helper < t.indexOf("On Wi-Fi") && helper < t.indexOf("On mobile data"))
        assertEquals(t.toString(), 2, t.count { it == "Up to 50 MB" })
        assertTrue("Storage for received files" in t)
        assertTrue("When full, the oldest files are removed from this device" in t)
        close(c)
    }
}
