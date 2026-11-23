package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.BuildConfig
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.push.PushDispatcher
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** After an app update, the first app open or push makes one GET /peers; the version is stored once it succeeds. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class VersionReportTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val calls = mutableListOf<String>()
    private var status = 200

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        app.fakeHttp = Interceptor { chain ->
            synchronized(calls) { calls += chain.request().method + " " + chain.request().url.encodedPath }
            val body = if (status == 200) "{\"peers\":[],\"my_allow\":[],\"my_push_sha256\":null}" else "{\"error\":\"server error\"}"
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("x")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private fun peersCalls() = synchronized(calls) { calls.count { it == "GET /v1/peers" } }

    private fun reported() = g.settings.get(Settings.K.REPORTED_VERSION)

    @Test fun versionChangedFetchesOnceAndStoresAfterSuccess() = io {
        g.settings.set(Settings.K.REPORTED_VERSION, "0.0.1")
        g.session.reportVersion()
        assertEquals(1, peersCalls())
        assertEquals(BuildConfig.VERSION_NAME, reported())
        // equal now: no more GET /peers
        g.session.reportVersion()
        g.session.reportVersion(inPush = true)
        assertEquals(1, peersCalls())
    }

    @Test fun versionEqualDoesNotFetch() = io {
        g.settings.set(Settings.K.REPORTED_VERSION, BuildConfig.VERSION_NAME)
        g.session.reportVersion()
        assertEquals(0, peersCalls())
    }

    @Test fun failedFetchDoesNotStoreTheVersion() = io {
        status = 400
        g.session.reportVersion()
        assertEquals(1, peersCalls())
        assertNull(reported())
        // the next trigger tries again, and a success stores it
        status = 200
        g.session.reportVersion()
        assertEquals(2, peersCalls())
        assertEquals(BuildConfig.VERSION_NAME, reported())
    }

    @Test fun signedOutOrNotRegisteredDoesNotFetch() = io {
        g.settings.set(Settings.K.SIGNED_OUT, true)
        g.session.reportVersion()
        g.settings.set(Settings.K.SIGNED_OUT, false)
        g.store.wipeRegistration()
        g.session.reportVersion()
        assertEquals(0, peersCalls())
        assertNull(reported())
    }

    @Test fun appOpenReportsAChangedVersion() = io {
        g.session.onAppOpen(System.currentTimeMillis())
        assertEquals(1, peersCalls())
        assertEquals(BuildConfig.VERSION_NAME, reported())
        g.session.onAppOpen(System.currentTimeMillis())
        assertEquals(1, peersCalls())
    }

    @Test fun pushReportsAChangedVersion() = io {
        PushDispatcher.onPush(g, "not a message", fcm = true)
        assertEquals(1, peersCalls())
        assertEquals(BuildConfig.VERSION_NAME, reported())
        PushDispatcher.onPush(g, "not a message", fcm = true)
        assertEquals(1, peersCalls())
    }
}
