package com.pusharmor.app.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** With no UnifiedPush app saved and exactly one installed, registration saves that one with no user step. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SingleDistributorTest {
    private val installed = UnifiedPushSupport.installed
    private val registerSaved = UnifiedPushSupport.registerSaved
    private var registered = 0
    private val app = ApplicationProvider.getApplicationContext<PaApp>()
    private val g get() = app.graph
    private val store get() = app.getSharedPreferences("unifiedpush.connector", Context.MODE_PRIVATE)

    @Before fun setUp() { UnifiedPushSupport.registerSaved = { registered++ } }

    @After fun restore() {
        UnifiedPushSupport.installed = installed
        UnifiedPushSupport.registerSaved = registerSaved
        store.edit().clear().commit()
        g.settings.set(Settings.K.BANNER, null)
        g.settings.set(Settings.K.PUSH_TYPE, null)
    }

    @Test fun oneInstalledIsSaved() {
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        UnifiedPushSupport.installed = { listOf("org.unifiedpush.distributor.sunup") }
        UnifiedPushSupport.register(g)
        assertEquals("org.unifiedpush.distributor.sunup", store.getString("unifiedpush.distributor", null))
        assertEquals(1, registered)
        assertNull(g.settings.get(Settings.K.BANNER))
    }

    @Test fun severalInstalledIsUnchanged() {
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        UnifiedPushSupport.installed = { listOf("io.heckel.ntfy", "org.unifiedpush.distributor.sunup") }
        UnifiedPushSupport.register(g)
        assertNull(store.getString("unifiedpush.distributor", null))
        assertEquals(0, registered)
        assertEquals("no_distributor", g.settings.get(Settings.K.BANNER))
    }
}
