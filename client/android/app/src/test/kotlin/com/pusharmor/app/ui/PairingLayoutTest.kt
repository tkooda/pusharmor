package com.pusharmor.app.ui

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.UiHostActivity
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.SelfEntity
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The pairing fingerprint and the Devices list at the largest font size. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = TestApp::class)
class PairingLayoutTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun roots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { roots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun flat(n: SemanticsNode): List<SemanticsNode> = listOf(n) + n.children.flatMap { flat(it) }
    private fun nodes(v: View) = roots(v).flatMap { flat(it.semanticsOwner.unmergedRootSemanticsNode) }
    private fun text(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text } ?: ""

    /** As in DeviceMenuTest: a frame left pending by an earlier test would stop this one from recomposing. */
    private fun unstickFrames() {
        val d = androidx.compose.ui.platform.AndroidUiDispatcher.CurrentThread[kotlin.coroutines.ContinuationInterceptor]!!
        for (n in listOf("scheduledFrameDispatch", "scheduledTrampolineDispatch")) {
            d.javaClass.getDeclaredField(n).apply { isAccessible = true }.setBoolean(d, false)
        }
    }

    /** The four cells sit on one row inside the card width: the plate is one cell high and inside the screen. */
    private fun assertOneRow(width: Int) {
        RuntimeEnvironment.setQualifiers("w${width}dp-h900dp-xhdpi")
        RuntimeEnvironment.setFontScale(2f)
        // As in the pairing card: 16 dp list margin, 16 dp card padding, 12 dp plate padding on each side.
        UiHostActivity.content = { Box(Modifier.fillMaxWidth().padding(horizontal = 44.dp)) { FingerprintPlate("GZJ3", "Pixel 9 Pro XL") } }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        idle()
        val a = c.get()
        val px = a.resources.displayMetrics.density
        val plate = nodes(a.window.decorView).first { n ->
            n.config.getOrNull(SemanticsProperties.ContentDescription)?.any { it == "Pairing fingerprint G, Z, J, 3" } == true
        }.boundsInRoot
        val cell = minOf(64f * px, (plate.width - 30f * px) / 4f)
        val screen = a.window.decorView.width
        assertTrue("$plate screen=$screen", plate.left >= 0f && plate.right <= screen)
        // One row of cells is one cell high (76 dp for a 64 dp cell); two rows would be more than twice that.
        assertTrue("$plate cell=$cell", plate.height > 0f && plate.height <= cell * 76f / 64f + 1f)
        c.pause().stop().destroy()
    }

    @Test fun fingerprintIsOneRowAt320dp() = assertOneRow(320)
    @Test fun fingerprintIsOneRowAt360dp() = assertOneRow(360)
    @Test fun fingerprintIsOneRowAt412dp() = assertOneRow(412)

    /** With the list scrolled to the end, the last row is above the Pair a new device button at the largest font size. */
    @Config(qualifiers = "w412dp-h915dp-xxhdpi", fontScale = 2f)
    @Test fun lastRowClearsTheFloatingButton() = lastRowClears()

    /** On a narrow window the button label takes two lines, so the button is taller; the list still clears it. */
    @Config(qualifiers = "w280dp-h640dp-xhdpi", fontScale = 2f)
    @Test fun lastRowClearsATallerFloatingButton() = lastRowClears()

    private fun lastRowClears() {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        val t = Thread {
            app.graph.dao.putSelf(SelfEntity(id = "s".repeat(40), accountPrefix = ByteArray(9), name = "Pixel 9 Pro XL", email = "someone@example.com"))
            for (i in 1..12) app.graph.dao.putPeer(PeerEntity(
                id = ('a' + i).toString().repeat(40), platform = "android", created = 1, listSignPub = null, listEncPub = null,
                signPub = "B".repeat(87), encPub = "C".repeat(87), pairingId = ByteArray(16), approved = true, deniedByMe = false,
                approveVerified = true, listApprovesMe = true, listDeniesMe = false, listAfterVerify = true, declined = false,
                reachable = true, loggedOut = false, logoutN = 0, hidden = false, name = "Device %02d".format(i), nameN = 1, removed = false, missing = false,
                lastN = 0, channelId = null, storedApprove = null, storedApproveName = null, lastApproveResult = null, lastSendAt = 0, note = null,
            ))
        }
        t.start(); t.join()
        unstickFrames()
        val vm = AppViewModel(app)
        while (vm.peers.value.size < 12 || vm.self.value == null) { Thread.sleep(20); idle() }
        UiHostActivity.content = { PeersScreen(vm) }
        val c = Robolectric.buildActivity(UiHostActivity::class.java).setup()
        idle()
        val v = c.get().window.decorView
        for (i in 0 until 100) { if (nodes(v).any { text(it) == "Device 01" }) break; Thread.sleep(50); idle() }
        for (i in 0 until 20) {
            nodes(v).first { it.config.getOrNull(SemanticsActions.ScrollBy) != null }.config[SemanticsActions.ScrollBy].action!!.invoke(0f, 100000f)
            Thread.sleep(20); idle()
        }
        val all = nodes(v)
        val list = all.first { it.config.getOrNull(SemanticsActions.ScrollBy) != null }
        assertTrue(flat(list).map { text(it) }.filter { it.isNotEmpty() }.toString(), flat(list).any { text(it) == "Device 12" })
        var fab: SemanticsNode? = all.first { text(it) == "Pair a new device" }
        while (fab != null && fab.config.getOrNull(SemanticsActions.OnClick) == null) fab = fab.parent
        val fabTop = fab!!.boundsInRoot.top
        val bottom = flat(list).drop(1).filter { it.boundsInRoot.height > 0f }.maxOf { it.boundsInRoot.bottom }
        assertTrue("last row bottom=$bottom fab top=$fabTop fab=${fab.boundsInRoot}", bottom <= fabTop)
        c.pause().stop().destroy()
    }
}
