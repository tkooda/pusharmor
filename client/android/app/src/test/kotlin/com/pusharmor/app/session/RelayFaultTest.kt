package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.ui.UiText
import com.pusharmor.app.ui.relayFaultShown
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The relay-side fault mark follows GET /peers and Check again; it shows for Google push only. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class RelayFaultTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.settings.set(Settings.K.PUSH_TYPE, "fcm"); Unit
    }

    @After fun done() = io {
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

    private fun fault() = g.settings.get(Settings.K.RELAY_FAULT)

    @Test fun peersReplySetsAndClearsTheMark() {
        reply(200, "{\"peers\":[],\"my_allow\":[],\"my_push_sha256\":null,\"my_relay_fault\":true}")
        assertTrue(io { g.session.fetchPeers(force = true) })
        assertEquals(true, fault())
        reply(200, "{\"peers\":[],\"my_allow\":[],\"my_push_sha256\":null}") // an older relay server: no field
        assertTrue(io { g.session.fetchPeers(force = true) })
        assertEquals(false, fault())
    }

    @Test fun checkAgainResults() {
        reply(200, "{\"result\":\"relay\"}")
        assertEquals("relay", io { g.session.checkPush() })
        assertEquals(true, fault())
        reply(200, "{\"result\":\"sent\"}")
        assertEquals("sent", io { g.session.checkPush() })
        assertEquals(false, fault())
        g.settings.set(Settings.K.RELAY_FAULT, true)
        reply(200, "{\"result\":\"failed\"}")
        assertEquals("failed", io { g.session.checkPush() })
        assertEquals(true, fault()) // unchanged: the card stays
        reply(429, "{\"error\":\"rate limited\"}")
        assertNull(io { g.session.checkPush() })
        assertEquals(true, fault())
        reply(200, "{\"result\":\"none\"}")
        assertEquals("none", io { g.session.checkPush() })
        assertEquals(true, fault())
        reply(200, "{\"result\":\"later\"}") // an unknown word changes nothing
        assertEquals("later", io { g.session.checkPush() })
        assertEquals(true, fault())
        reply(503, "{\"error\":\"server error\"}") // any error reply but 429 counts as failed
        assertEquals("failed", io { g.session.checkPush() })
        assertEquals(true, fault())
        reply(200, "{\"result\":\"gone\"}") // gone keeps the card while the push address is sent again
        assertEquals("gone", io { g.session.checkPush() })
        assertEquals(true, fault())
        app.fakeHttp = Interceptor { throw java.io.IOException("offline") }
        assertNull(io { g.session.checkPush() })
        assertEquals(true, fault())
    }

    /** The line after Check again, for each outcome; null adds no line. */
    @Test fun checkAgainLines() {
        val still = "Still cannot receive messages."
        val unable = "Unable to check right now. Try again later."
        assertEquals(still, UiText.checkAgainText(localCause = true, word = null))
        assertEquals("Working", UiText.checkAgainText(false, "sent"))
        for (w in listOf("relay", "gone", "failed", "later")) assertEquals(w, still, UiText.checkAgainText(false, w))
        assertNull(UiText.checkAgainText(false, "none"))
        assertEquals(unable, UiText.checkAgainText(false, null)) // network error or HTTP 429
    }

    @Test fun shownForGooglePushOnly() {
        assertTrue(relayFaultShown(true, "fcm", google = true))
        assertFalse(relayFaultShown(false, "fcm", google = true))
        assertFalse(relayFaultShown(true, "unifiedpush", google = true))
        assertFalse(relayFaultShown(true, null, google = false))
    }
}
