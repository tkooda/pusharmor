package com.pusharmor.app.session

import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import androidx.datastore.preferences.core.Preferences
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.push.UnifiedPushSupport
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A push address the relay server refuses shows its host and app on the card; an accepted address clears it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class PushRefusedTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        g.settings.set(Settings.K.UP_ENDPOINT, "https://push.example.org/up/abc")
        g.settings.set(Settings.K.UP_P256DH, "p"); g.settings.set(Settings.K.UP_AUTH, "a"); Unit
    }

    private val savedApp = UnifiedPushSupport.saved

    @After fun done() = io {
        UnifiedPushSupport.saved = savedApp
        app.fakeHttp = null
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private fun reply(code: Int, body: String) {
        app.fakeHttp = Interceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }
    }

    private fun prefs(): Preferences = io { runBlocking { g.settings.data.first() } }

    /** A UnifiedPush app named "ntfy". */
    private fun installNtfy() {
        val pkg = "io.heckel.ntfy"
        val ai = ApplicationInfo().apply { packageName = pkg; nonLocalizedLabel = "ntfy" }
        val pm = shadowOf(app.packageManager)
        pm.installPackage(PackageInfo().apply { packageName = pkg; applicationInfo = ai })
    }

    @Test fun refusedThenAccepted() {
        installNtfy()
        UnifiedPushSupport.saved = { "io.heckel.ntfy" }
        reply(400, "{\"error\":\"push endpoint not allowed\"}")
        assertNull(io { g.session.patchPushNow() })
        assertEquals(true, g.settings.get(Settings.K.PUSH_REFUSED))
        assertEquals("push.example.org" to "ntfy", UnifiedPushSupport.refused(app, prefs(), playServices = true))
        reply(200, "{}")
        assertEquals(true, io { g.session.patchPushNow() })
        assertEquals(false, g.settings.get(Settings.K.PUSH_REFUSED))
        assertNull(UnifiedPushSupport.refused(app, prefs(), playServices = true))
    }
}
