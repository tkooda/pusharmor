package com.pusharmor.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** "Get ntfy" opens Google Play only where Play can install it: the play build on a device with Play services. */
class NtfyUrlTest {
    @Test fun playOnlyWithPlayServices() {
        val play = "https://play.google.com/store/apps/details?id=io.heckel.ntfy"
        val fdroid = "https://f-droid.org/packages/io.heckel.ntfy/"
        assertEquals(play, ntfyUrl(playBuild = true, google = true))
        assertEquals(fdroid, ntfyUrl(playBuild = true, google = false))
        assertEquals(fdroid, ntfyUrl(playBuild = false, google = true))
        assertEquals(fdroid, ntfyUrl(playBuild = false, google = false))
    }
}
