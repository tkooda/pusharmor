package com.pusharmor.app.session

import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.protocol.Peer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.w3c.dom.Element
import javax.xml.parsers.DocumentBuilderFactory

/** Every paired device in the All set with its sharing checkbox on is a direct share target; the share target is declared where Android reads it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class ShareShortcutsTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private fun paired(id: String, name: String) = Peer(id = id, platform = "firefox", signPub = "s", encPub = "e", pairingId = ByteArray(16),
        approved = true, approveVerified = true, name = name)

    private fun ids() = ShortcutManagerCompat.getDynamicShortcuts(app).map { it.id }.toSet()

    @After fun done() = io {
        ShortcutManagerCompat.removeAllDynamicShortcuts(app)
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
    }

    @Test fun checkboxDecidesTheShortcut() {
        io { g.store.putPeer(paired("a", "Firefox mobile")); g.store.putPeer(paired("b", "Laptop")); g.session.updateShortcuts() }
        assertEquals(setOf("a", "b"), ids())
        val sc = ShortcutManagerCompat.getDynamicShortcuts(app).first { it.id == "a" }
        assertTrue(Session.SHARE_CATEGORY in sc.categories!!)
        assertEquals("Firefox mobile", sc.shortLabel)
        io { g.settings.setShareShown("a", false); g.session.updateShortcuts() }
        assertEquals(setOf("b"), ids())
        io { g.settings.setShareShown("a", true); g.session.updateShortcuts() }
        assertEquals(setOf("a", "b"), ids())
    }

    @Test fun halfPairedDeviceHasNoShortcut() {
        io { g.store.putPeer(paired("a", "Phone").copy(approveVerified = false)); g.session.updateShortcuts() }
        assertEquals(emptySet<String>(), ids())
    }

    private fun xml(path: String) = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = false }.newDocumentBuilder()
        .parse(java.io.File("src/main/$path")).documentElement

    private fun Element.children(tag: String): List<Element> =
        (0 until childNodes.length).map { childNodes.item(it) }.filterIsInstance<Element>().filter { it.tagName == tag }

    @Test fun shareTargetIsOnTheLauncherActivity() {
        val appEl = xml("AndroidManifest.xml").children("application").single()
        val launcher = appEl.children("activity").single { a ->
            a.children("intent-filter").any { f -> f.children("category").any { it.getAttribute("android:name") == "android.intent.category.LAUNCHER" } }
        }
        assertTrue(launcher.children("meta-data").any { it.getAttribute("android:name") == "android.app.shortcuts" && it.getAttribute("android:resource") == "@xml/shortcuts" })
        assertTrue(appEl.children("meta-data").none { it.getAttribute("android:name") == "android.app.shortcuts" })

        val target = xml("res/xml/shortcuts.xml").children("share-target").single()
        assertEquals(Session.SHARE_CATEGORY, target.children("category").single().getAttribute("android:name"))
        val mime = target.children("data").single().getAttribute("android:mimeType")
        val share = appEl.children("activity").single { "com.pusharmor.app" + it.getAttribute("android:name") == target.getAttribute("android:targetClass") }
        assertTrue(share.children("intent-filter").any { f ->
            f.children("action").any { it.getAttribute("android:name") == "android.intent.action.SEND" } &&
                f.children("data").any { it.getAttribute("android:mimeType") == mime }
        })
    }
}
