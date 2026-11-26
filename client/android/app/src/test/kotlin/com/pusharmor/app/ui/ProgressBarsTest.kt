@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package com.pusharmor.app.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.files.FileState
import com.pusharmor.app.files.ReceivedFiles
import com.pusharmor.app.ui.theme.PushArmorTheme
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

/** The step bar fills by the steps (a one-step flow spins), and a decrypting file row fills by the bytes read. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class, qualifiers = "w411dp-h600dp")
class ProgressBarsTest {
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
    private fun bars(v: View) = nodes(v).mapNotNull { it.config.getOrNull(SemanticsProperties.ProgressBarRangeInfo) }

    private fun frames(v: View, n: Int = 1) = repeat(n) {
        Snapshot.sendApplyNotifications()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
        clock.sendFrame(SystemClock.uptimeMillis() * 1_000_000)
        shadowOf(Looper.getMainLooper()).idle()
        roots(v).forEach { it.measureAndLayoutForTest() }
    }

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit, until: (View) -> Boolean): Pair<org.robolectric.android.controller.ActivityController<ComponentActivity>, View> {
        scope.launch { recomposer.runRecomposeAndApplyChanges() }
        val c = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val view = ComposeView(c.get()).apply { setParentCompositionContext(recomposer) }
        c.get().setContentView(view)
        view.setContent { PushArmorTheme(dark = false) { Surface { content() } } }
        val v = c.get().window.decorView
        val end = System.currentTimeMillis() + 10_000
        while (!until(v) && System.currentTimeMillis() < end) { Thread.sleep(20); frames(v) }
        frames(v, 3)
        return c to v
    }

    private fun close(c: org.robolectric.android.controller.ActivityController<ComponentActivity>) {
        c.pause().stop().destroy()
        recomposer.cancel()
        scope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun shot(v: View, name: String) {
        val dir = System.getenv("PA_SHOT_DIR") ?: return
        val b = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        v.draw(Canvas(b))
        java.io.File(dir).mkdirs()
        java.io.File(dir, name).outputStream().use { b.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun stepBarFillsByTheSteps() {
        val vm = AppViewModel(ApplicationProvider.getApplicationContext<PaApp>())
        vm.captionStep.value = 2 to 3
        vm.caption.value = "Setting up this device"
        val (c, v) = show({ StepBar(vm, Modifier.padding(16.dp)) }) { bars(it).isNotEmpty() }
        val b = bars(v).single()
        assertTrue(b.toString(), b != ProgressBarRangeInfo.Indeterminate)
        assertEquals(2f / 3, b.current, 0.001f)
        shot(v, "android-stepbar-2of3.png")
        close(c)
    }

    @Test fun oneStepFlowSpins() {
        val vm = AppViewModel(ApplicationProvider.getApplicationContext<PaApp>())
        vm.captionStep.value = 1 to 1
        vm.caption.value = "Logging out"
        val (c, v) = show({ StepBar(vm, Modifier.padding(16.dp)) }) { bars(it).isNotEmpty() }
        assertEquals(ProgressBarRangeInfo.Indeterminate, bars(v).single())
        shot(v, "android-stepbar-onestep.png")
        close(c)
    }

    @Test fun decryptBarFillsByTheBytes() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val g = app.graph
        val now = System.currentTimeMillis()
        val key43 = com.pusharmor.crypto.B64url.encode(ByteArray(32) { it.toByte() })
        val f = FileValue("https://b2file.pusharmor.com/v1/x", now / 1000 + 3600, key43, "report.pdf", 2_100_000, key43)
        val h = runBlocking(Dispatchers.IO) {
            androidx.work.WorkManager.getInstance(app).cancelAllWork().result.get()
            g.fileStore.root.deleteRecursively()
            g.settings.set(Settings.K.FILE_WIFI, 0L)
            g.settings.set(Settings.K.FILE_MOBILE, 0L)
            val e = HistoryEntity(direction = "RECEIVED", peerId = null, type = "file", content = f.toJson(),
                n = null, pairingId = null, at = now, read = true, results = "", count = 1)
            val id = g.dao.insertHistory(e)
            g.fileStore.put(ReceivedFiles.key(id), FileState(downloaded = true))
            g.dao.history(id)!!
        }
        val vm = AppViewModel(app)
        runBlocking { vm.files.refresh(decrypt = false).join() }
        vm.files.decryptPercent.value = h.id to 40
        val (c, v) = show({ FileRowBody(vm, h, f, MaterialTheme.typography.bodyLarge, now, expanded = true) }) { bars(it).isNotEmpty() }
        val b = bars(v).single()
        assertTrue(b.toString(), b != ProgressBarRangeInfo.Indeterminate)
        assertEquals(0.4f, b.current, 0.001f)
        shot(v, "android-decrypting-40.png")
        close(c)
    }
}
