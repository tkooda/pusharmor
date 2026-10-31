package com.pusharmor.app.data

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.session.Session
import com.pusharmor.protocol.Peer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The global "Direct share targets" switch became a per-device "Show in share sheet" (I598). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class ShareSheetMigrationTest {
    private fun settings(): Settings {
        val ctx = ApplicationProvider.getApplicationContext<android.app.Application>()
        return Settings(ctx).also { it.set(Settings.K.DIRECT_SHARE, null); it.set(Settings.K.SHARE_OFF, null) } // the DataStore is shared across tests
    }

    @Test fun oldOffTurnsEveryDeviceOff() {
        val s = settings()
        s.set(Settings.K.DIRECT_SHARE, false)
        s.migrateDirectShare(listOf("a", "b"))
        assertEquals(setOf("a", "b"), s.shareOff)
        assertNull(s.get(Settings.K.DIRECT_SHARE))
        // Runs once: a device added later stays on.
        s.migrateDirectShare(listOf("a", "b", "c"))
        assertEquals(setOf("a", "b"), s.shareOff)
    }

    @Test fun oldOnOrAbsentKeepsEveryDeviceOn() {
        val s = settings()
        s.set(Settings.K.DIRECT_SHARE, true)
        s.migrateDirectShare(listOf("a"))
        assertEquals(emptySet<String>(), s.shareOff)
        assertNull(s.get(Settings.K.DIRECT_SHARE))
        s.migrateDirectShare(listOf("a"))
        assertEquals(emptySet<String>(), s.shareOff)
    }

    @Test fun perDeviceToggle() {
        val s = settings()
        s.setShareShown("a", false)
        s.setShareShown("b", false)
        s.setShareShown("a", true)
        assertEquals(setOf("b"), s.shareOff)
    }

    @Test fun shortcutsOnlyForDevicesShownInTheShareSheet() {
        val paired = Peer(id = "a", platform = "chrome", signPub = "s", encPub = "e", pairingId = ByteArray(16), approved = true, approveVerified = true)
        val other = paired.copy(id = "b")
        val unpaired = paired.copy(id = "c", signPub = null, encPub = null, pairingId = null, approved = false, approveVerified = false)
        assertEquals(listOf("a", "b"), Session.shareTargets(listOf(paired, other, unpaired), emptySet()).map { it.id })
        assertEquals(listOf("b"), Session.shareTargets(listOf(paired, other, unpaired), setOf("a")).map { it.id })
    }
}
