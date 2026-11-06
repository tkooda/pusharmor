package com.pusharmor.app.session

import com.pusharmor.protocol.Peer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ShortcutLabelTest {
    @Test fun namedDeviceKeepsItsName() {
        assertEquals("Pixel", Session.shortcutLabel(Peer(id = "a", name = "Pixel")))
    }

    @Test fun unnamedDevicesGetTheAppFallbackNotOneSharedLabel() {
        val a = Session.shortcutLabel(Peer(id = "a", platform = "android", created = 1_762_300_800))
        val b = Session.shortcutLabel(Peer(id = "b", platform = "ios", created = 1_762_300_800))
        assertNotEquals("Device", a)
        assertNotEquals(a, b)
        assertEquals(true, a.contains("device added"))
    }
}
