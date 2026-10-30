package com.pusharmor.app.shots

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.pusharmor.app.PaApp
import com.pusharmor.app.ScreenshotMode
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.ui.MainActivity
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.ShownContent
import com.pusharmor.store.HistoryEntity
import com.pusharmor.store.PairingEntity
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.SelfEntity
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Store screenshots with sample data (tools/screenshots.sh). Skipped unless the runner gets
 * "-e shots 1". Wipes this device's registration; the mode blocks every Worker call.
 */
@RunWith(AndroidJUnit4::class)
class ScreenshotCapture {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val g by lazy { app.graph }

    private fun id(c: Char) = c.toString().repeat(40)
    private val self = id('S')
    private val laptop = id('L')
    private val desktop = id('W')
    private val tablet = id('T')
    private val newLaptop = id('N')

    private fun shell(cmd: String) {
        inst.uiAutomation.executeShellCommand(cmd).close()
    }

    private fun shellOut(cmd: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(inst.uiAutomation.executeShellCommand(cmd)).use { it.readBytes().decodeToString() }

    /** Snoozes every notification of other packages (emulator "Android System" notices) for the run. */
    private fun snoozeOthers() {
        shellOut("cmd notification list").lines().map { it.trim() }
            .filter { it.split('|').getOrNull(1).let { p -> p != null && p != app.packageName } }
            .forEach { shell("cmd notification snooze --for 3600000 $it") }
    }

    private fun settle(ms: Long = 2500) {
        inst.waitForIdleSync()
        Thread.sleep(ms)
    }

    /** Window roots: every window when FLAG_RETRIEVE_INTERACTIVE_WINDOWS is set, else the active one. */
    private fun roots(): List<AccessibilityNodeInfo> =
        inst.uiAutomation.windows.mapNotNull { it.root }.ifEmpty { listOfNotNull(inst.uiAutomation.rootInActiveWindow) }

    private fun dump(n: AccessibilityNodeInfo?, depth: Int, out: StringBuilder) {
        if (n == null) return
        out.append("  ".repeat(depth)).append(n.className).append(" text=").append(n.text)
            .append(" desc=").append(n.contentDescription).append('\n')
        for (i in 0 until n.childCount) dump(n.getChild(i), depth + 1, out)
    }

    /** Compose roots under [v]: each AndroidComposeView is a ViewRootForTest. */
    private fun composeRoots(v: View): List<ViewRootForTest> = when (v) {
        is ViewRootForTest -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { composeRoots(v.getChildAt(it)) }
        else -> emptyList()
    }

    private fun nodeHas(n: SemanticsNode, text: String): Boolean =
        n.config.getOrNull(SemanticsProperties.Text)?.any { it.text.contains(text) } == true ||
            n.config.getOrNull(SemanticsProperties.ContentDescription)?.any { it.contains(text) } == true ||
            n.children.any { nodeHas(it, text) }

    /**
     * True when the resumed activity's Compose semantics tree holds [text]: the list state as
     * composed, read on the main thread, with no dependence on the accessibility node cache.
     */
    private fun composed(text: String): Boolean {
        var found = false
        inst.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .flatMap { composeRoots(it.window.decorView) }
                .any { nodeHas(it.semanticsOwner.unmergedRootSemanticsNode, text) }
        }
        return found
    }

    /**
     * Waits until [text] is composed (Room reads are async): polls the Compose tree after each
     * main-thread idle; on timeout saves a debug shot, logs the accessibility tree, fails.
     */
    private fun awaitText(text: String, timeoutMs: Long = 15_000) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            inst.waitForIdleSync()
            if (composed(text)) return
            Thread.sleep(250)
        }
        val tree = StringBuilder()
        roots().forEach { dump(it, 0, tree) }
        tree.lines().forEach { Log.e("ScreenshotCapture", it) }
        shot("debug-missing-" + text.replace(Regex("[^A-Za-z0-9]"), "_"))
        throw AssertionError("not shown within ${timeoutMs}ms: $text (tree in logcat, tag ScreenshotCapture)")
    }

    /** Walks the tree: Compose's node provider does not implement findAccessibilityNodeInfosByText. */
    private fun hasText(n: AccessibilityNodeInfo?, text: String): Boolean {
        if (n == null) return false
        if (n.text?.contains(text) == true || n.contentDescription?.contains(text) == true) return true
        return (0 until n.childCount).any { hasText(n.getChild(it), text) }
    }

    private fun shot(name: String) {
        // A system "... isn't responding" dialog over the app spoils the shot: fail instead.
        if (!name.startsWith("debug-")) assertTrue("system dialog over $name", roots().none { hasText(it, "t responding") })
        val bmp: Bitmap = inst.uiAutomation.takeScreenshot()
        val dir = File(app.getExternalFilesDir(null), "shots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { assertTrue(bmp.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }

    private fun paired(id: String, platform: String, name: String, created: Long) = PeerEntity(
        id = id, platform = platform, created = created, listSignPub = null, listEncPub = null,
        signPub = "B".repeat(87), encPub = "C".repeat(87), pairingId = ByteArray(16), approved = true, deniedByMe = false,
        approveVerified = true, listApprovesMe = true, listDeniesMe = false, listAfterVerify = true, declined = false,
        reachable = true, paused = false, pauseN = 0, hidden = false, name = name, nameN = 1, removed = false, missing = false,
        lastN = 0, channelId = null, storedApprove = null, storedApproveName = null, lastApproveResult = null, lastSendAt = 0, note = null,
    )

    private fun history(dir: String, peer: String, type: String, content: String, at: Long, read: Boolean) =
        if (dir == "SENT") HistoryEntity(direction = dir, peerId = null, type = type, content = content, n = null, pairingId = null, at = at,
            read = read, results = "{\"$peer\":\"sent\"}", count = 1) // as SendFlow stores it: no peer id, one result
        else HistoryEntity(direction = dir, peerId = peer, type = type, content = content, n = null, pairingId = null, at = at,
            read = read, results = "{}", count = 1)

    private fun main(route: String? = null, await: String) {
        val i = if (route == null) Intent(app, MainActivity::class.java) else MainActivity.openIntent(app, route)
        app.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        awaitText(await)
        settle()
    }

    @Test fun capture() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("shots") == "1")
        ScreenshotMode.on = true
        inst.uiAutomation.serviceInfo = inst.uiAutomation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        inst.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        shell("appops set ${app.packageName} AUTO_REVOKE_PERMISSIONS_IF_UNUSED ignore")

        val now = System.currentTimeMillis()
        // History times sit just before the 9:41 demo clock in the status bar.
        val clock = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, 9); set(java.util.Calendar.MINUTE, 41); set(java.util.Calendar.SECOND, 0)
        }.timeInMillis
        val secs = now / 1000
        g.store.wipeRegistration()
        g.dao.deleteAllHistory()
        g.settings.clearKeepingOldId()
        g.notifier.ensureChannels() // the clear dropped the channel ids
        KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = self, accountPrefix = ByteArray(9), name = "Phone"))
        g.dao.putPeer(paired(laptop, "chrome", "Laptop", secs - 40 * 86400))
        g.dao.putPeer(paired(desktop, "firefox", "Work desktop", secs - 30 * 86400))
        g.dao.putPeer(paired(tablet, "android", "Tablet", secs - 20 * 86400))
        g.dao.insertHistory(history("SENT", tablet, "url", "https://example.com/guide/hiking-trails", clock - 2 * 3600_000, true))
        g.dao.insertHistory(history("RECEIVED", desktop, "text", "Meeting moved to 3 pm, room B", clock - 25 * 60_000, true))
        val link = "https://example.com/recipes/lentil-soup"
        val linkId = g.dao.insertHistory(history("RECEIVED", laptop, "url", link, clock - 2 * 60_000, false))

        main(await = "Work desktop")
        shot("01-peers")

        // 02: the link heads-up over the app.
        snoozeOthers()
        g.notifier.createPeerChannel(laptop) // a paired peer has its own channel
        g.notifier.content(linkId, laptop, ShownContent(ContentType.URL, link, href = link, host = "example.com"))
        settle(3000)
        shot("02-notification")

        ScreenshotMode.sendText = "https://example.com/recipes/weeknight-pasta"
        ScreenshotMode.sendTo = listOf(laptop, desktop, tablet)
        main("send", await = "Tablet")
        shot("03-send")

        g.dao.putPeer(paired(newLaptop, "chrome", "New laptop", secs - 50 * 86400).copy(signPub = null, encPub = null, pairingId = null,
            approved = false, approveVerified = false, listApprovesMe = false, listAfterVerify = false)) // oldest: first on screen
        g.dao.putPairing(PairingEntity(peerId = newLaptop, role = "X", state = "SHOWN", r = ByteArray(32), cN = null,
            peerSignPub = null, peerEncPub = null, peerR = null, startedAt = now, pendingKind = null, pendingMessage = null,
            notBefore = 0, authorized = true, fingerprint = "K7QD", lastSendAt = now, lastResult = null))
        main(await = "Pair with new device")
        shot("04-pairing")

        main("history", await = "Meeting moved")
        shot("05-history")
    }
}
