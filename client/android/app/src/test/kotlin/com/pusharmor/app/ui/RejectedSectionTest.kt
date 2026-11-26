package com.pusharmor.app.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.UiHostActivity
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.SelfEntity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The Devices tab: rejected devices list under a collapsed Rejected devices section at the bottom, each with Pair. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class RejectedSectionTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>()
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    private fun peer(id: String, name: String, paired: Boolean, deniedByMe: Boolean) = PeerEntity(
        id = id, platform = "android", created = 1, listSignPub = "B".repeat(87), listEncPub = "C".repeat(87),
        signPub = if (paired) "B".repeat(87) else null, encPub = if (paired) "C".repeat(87) else null, pairingId = if (paired) ByteArray(16) else null,
        approved = paired, deniedByMe = deniedByMe, approveVerified = paired, listApprovesMe = paired, listDeniesMe = false, listAfterVerify = paired, declined = false,
        reachable = true, loggedOut = false, logoutN = 0, hidden = false, name = name, nameN = 1, removed = false, missing = false,
        lastN = 0, channelId = null, storedApprove = null, storedApproveName = null, lastApproveResult = null, lastSendAt = 0, note = null,
    )

    @After fun done() {
        // No frame left due for the next test's taps.
        idle(); unstickFrames()
        val t = Thread { app.graph.store.wipeRegistration() }
        t.start(); t.join()
    }

    private fun shot(v: View, name: String) {
        val dir = System.getenv("PA_SHOT_DIR") ?: return
        val b = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        v.draw(Canvas(b))
        java.io.File(dir).mkdirs()
        java.io.File(dir, name).outputStream().use { b.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** As in DeviceMenuTest: an earlier test can leave the UI dispatcher thinking a frame is due, so a tap never recomposes. */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }

    @Config(qualifiers = "w412dp-h915dp-420dpi")
    @Test fun rejectedDevicesSectionIsCollapsedAndOpensToPair() {
        unstickFrames()
        val t = Thread {
            app.graph.dao.putSelf(SelfEntity(id = "s".repeat(40), accountPrefix = ByteArray(9), name = "Pixel 8", email = "someone@example.com"))
            app.graph.dao.putPeer(peer("a".repeat(40), "Galaxy S23", paired = true, deniedByMe = false))
            app.graph.dao.putPeer(peer("r".repeat(40), "Old tablet", paired = false, deniedByMe = true))
        }
        t.start(); t.join()
        val vm = AppViewModel(app)
        while (vm.peers.value.size < 2 || vm.self.value == null) { Thread.sleep(20); idle() }
        UiHostActivity.content = { PeersScreen(vm) }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        val a = c.get()
        idle()
        var all = nodes(a.window.decorView)
        val header = all.first { text(it) == "Rejected devices (1)" }
        assertTrue(all.none { text(it) == "Old tablet" })
        assertEquals(listOf("Paired devices", "Rejected devices (1)"), all.map { text(it) }.filter { it == "Paired devices" || it == "Rejected devices (1)" })
        shot(a.window.decorView, "android-collapsed.png")
        var n: SemanticsNode? = header
        while (n != null && n.config.getOrNull(SemanticsActions.OnClick) == null) n = n.parent
        n!!.config[SemanticsActions.OnClick].action!!.invoke()
        // Composed again from saved state (as in DevicesScreenTest), so the open section shows without waiting for a frame.
        c.recreate(); idle()
        val b = c.get()
        all = nodes(b.window.decorView)
        val texts = all.map { text(it) }
        assertTrue(texts.toString(), "Old tablet" in texts)
        // The rejected row offers Pair, and no Reject.
        assertTrue(texts.toString(), texts.indexOf("Old tablet") > texts.indexOf("Rejected devices (1)") && texts.lastIndexOf("Pair") > texts.indexOf("Old tablet"))
        assertTrue(texts.toString(), "Reject" !in texts)
        shot(b.window.decorView, "android-open.png")
        c.pause().stop().destroy(); idle()
    }
}
