package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SessionRegisterTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph

    @Before fun keystore() = FakeAndroidKeyStore.install()
    @After fun done() { app.fakeHttp = null; FakeAndroidKeyStore.remove() }

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private fun reply(chain: Interceptor.Chain, code: Int, body: String, epoch: Long): Response =
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
            .header("PA-Epoch", epoch.toString()).body(body.toResponseBody("application/json".toMediaType())).build()

    /** With no self row the learned clock offset is kept, not dropped. */
    @Test fun offsetIsKeptBeforeRegistration() = io {
        g.offset.offsetS = 600
        assertEquals(600L, g.offset.offsetS)
    }

    /** A registration that meets a skewed clock signs again with the corrected clock and succeeds. */
    @Test fun registerRetriesOnceAfterClockSkew() = io {
        val signPub = g.session.keysForSignIn()
        val k = g.keysOrNull!!
        val id = B64url.encode(ByteArray(9) { 7 } + Ids.keyhash(k.signPub, k.encPub) + ByteArray(9))
        val epoch = System.currentTimeMillis() / 1000 + 600
        val times = mutableListOf<Long>()
        app.fakeHttp = Interceptor { chain ->
            times += chain.request().header("PA-Time")!!.toLong()
            if (times.size == 1) reply(chain, 401, "{\"error\":\"clock skew\"}", epoch)
            else reply(chain, 200, "{\"id\":\"$id\",\"peers\":[]}", epoch)
        }
        assertTrue(signPub.isNotEmpty())
        val r = g.session.onTicket("t", "a@b.c")
        assertTrue((r as? Session.SignIn.Error)?.text + " calls=" + times.size, r is Session.SignIn.Done)
        assertEquals(2, times.size)
        assertTrue(Math.abs(times[1] - epoch * 1000) < 5000)
        assertTrue(g.offset.offsetS in 500L..605L) // about 600 s, less the seconds the test took
    }

    /** A sign-in that fails leaves the "removed" banner on screen. */
    @Test fun failedSignInKeepsTheBanner() = io {
        g.keysOrNull = null
        g.settings.set(Settings.K.BANNER, Session.REMOVED)
        assertTrue(g.session.onTicket("t", "a@b.c") is Session.SignIn.Error)
        assertEquals(Session.REMOVED, g.settings.get(Settings.K.BANNER))
    }
}
