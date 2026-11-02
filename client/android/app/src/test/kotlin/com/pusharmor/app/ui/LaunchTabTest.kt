package com.pusharmor.app.ui

import android.content.Intent
import com.pusharmor.protocol.Peer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A plain launch opens Send when at least one pairing is complete, else Devices. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class LaunchTabTest {
    private fun peer(id: String, pinned: Boolean, approved: Boolean, verified: Boolean) =
        Peer(id = id, platform = "android", created = 0, signPub = if (pinned) "s" else null,
            encPub = if (pinned) "e" else null, pairingId = if (pinned) ByteArray(32) else null,
            approved = approved, approveVerified = verified)

    @Test fun completePairingOpensSend() {
        assertEquals("send", launchRoute(listOf(peer("me", true, true, true), peer("a", true, true, true)), "me"))
    }

    @Test fun noCompletePairingOpensDevices() {
        assertEquals("peers", launchRoute(emptyList(), "me"))
        assertEquals("peers", launchRoute(listOf(peer("a", false, false, false)), "me"))
        assertEquals("peers", launchRoute(listOf(peer("a", true, true, false)), "me")) // waiting for the other device
        assertEquals("peers", launchRoute(listOf(peer("me", true, true, true)), "me"))
    }

    @Test fun onlyALauncherStartIsPlain() {
        assertTrue(MainActivity.isPlainLaunch(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)))
        assertFalse(MainActivity.isPlainLaunch(Intent(Intent.ACTION_VIEW)))
        assertFalse(MainActivity.isPlainLaunch(Intent(Intent.ACTION_MAIN).setClassName("com.pusharmor.app", MainActivity.OPEN_ALIAS).putExtra("route", "history")))
        assertFalse(MainActivity.isPlainLaunch(Intent(Intent.ACTION_MAIN).setClassName("com.pusharmor.app", MainActivity.AUTH_ALIAS).putExtra("ticket", "t")))
    }
}
