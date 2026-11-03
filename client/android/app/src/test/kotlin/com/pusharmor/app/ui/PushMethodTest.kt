package com.pusharmor.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** Push method lists Google only where Play services run, then every installed UnifiedPush app by its name. */
class PushMethodTest {
    private val apps = listOf("org.unifiedpush.distributor.sunup" to "Sunup", "io.heckel.ntfy" to "ntfy")

    @Test fun googleOnlyWithPlayServices() {
        assertEquals(listOf(PUSH_GOOGLE, "io.heckel.ntfy", "org.unifiedpush.distributor.sunup"), pushOptions(google = true, apps))
        assertEquals(listOf("io.heckel.ntfy", "org.unifiedpush.distributor.sunup"), pushOptions(google = false, apps))
        assertEquals(emptyList<String>(), pushOptions(google = false, emptyList()))
    }

    @Test fun currentChoice() {
        assertEquals(PUSH_GOOGLE, pushCurrent(null, google = true, saved = null))
        assertEquals(PUSH_GOOGLE, pushCurrent("fcm", google = true, saved = "io.heckel.ntfy"))
        assertEquals("io.heckel.ntfy", pushCurrent("unifiedpush", google = true, saved = "io.heckel.ntfy"))
        assertEquals("io.heckel.ntfy", pushCurrent(null, google = false, saved = "io.heckel.ntfy"))
        assertEquals(null, pushCurrent(null, google = false, saved = null))
    }

    /** No push service in use: "None available" (shown in the theme's error color). */
    @Test fun valueNames() {
        assertEquals("Google", pushMethodName(PUSH_GOOGLE, apps))
        assertEquals("ntfy", pushMethodName("io.heckel.ntfy", apps))
        assertEquals("None available", pushMethodName(null, apps))
        assertEquals("None available", pushMethodName("gone.app", apps))
    }

    @Test fun getAppTexts() {
        assertEquals("Get a UnifiedPush app", UiText.GET_PUSH_APP)
        assertEquals("ntfy (recommended)", UiText.NTFY_NAME)
        assertEquals("Free and open source. Keeps a light connection to deliver messages right away.", UiText.NTFY_ABOUT)
        assertEquals("Sunup", UiText.SUNUP_NAME)
        assertEquals("Free and open source. Delivers through Mozilla's push service.", UiText.SUNUP_ABOUT)
    }
}
