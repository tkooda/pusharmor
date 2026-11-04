package com.pusharmor.app.ui

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.session.Session
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/** Refresh and pull-to-refresh on the Devices screen share one grey time. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class RefreshGreyTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val calls = AtomicInteger()

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        app.fakeHttp = Interceptor { chain ->
            calls.incrementAndGet()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(500).message("x")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    /** Refresh and pull-to-refresh: greyed 10 s after use, then one tap runs again. */
    @Test fun refreshGreyIsTenSeconds() {
        assertEquals(10_000L, Session.REFRESH_GREY_MS)
        g.settings.set(Settings.K.LAST_REFRESH, System.currentTimeMillis() - 5_000)
        io { g.session.refresh() }
        assertEquals("a refresh inside the grey time calls nothing", 0, calls.get())
        g.settings.set(Settings.K.LAST_REFRESH, System.currentTimeMillis() - 10_001)
        io { g.session.refresh() }
        assert(calls.get() > 0) { "a refresh after the grey time calls the relay server" }
    }
}
