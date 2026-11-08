package com.pusharmor.app.session

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.ui.AppViewModel
import com.pusharmor.app.ui.UiText
import com.pusharmor.net.ErrorText
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.engine.ApiResult
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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

/** A push address or pairing message the relay server does not take, after the last try, shows why on the device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class PushErrorTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.settings.set(Settings.K.PUSH_TYPE, "fcm")
        g.settings.set(Settings.K.PUSH_TOKEN, "token-1"); Unit
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

    private fun waitFor(cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5000
        while (!cond() && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
    }

    /** Google push refused with 400 "push endpoint not allowed": the card says the push service is not supported; an accepted address clears it. */
    @Test fun googlePushRefusedShowsNotSupported() {
        reply(400, "{\"error\":\"push endpoint not allowed\"}")
        assertNull(io { g.session.patchPushNow() })
        assertEquals(ErrorText.PUSH_NOT_SUPPORTED, g.settings.get(Settings.K.PUSH_ERROR))
        assertEquals(null, g.settings.get(Settings.K.PUSH_REFUSED))
        reply(200, "{}")
        assertEquals(true, io { g.session.patchPushNow() })
        assertNull(g.settings.get(Settings.K.PUSH_ERROR))
    }

    /** 401 "bad id": the card says the relay server did not accept the request, also when the PATCH is skipped later. */
    @Test fun badIdShowsWhy() {
        reply(401, "{\"error\":\"bad id\"}")
        assertNull(io { g.session.patchPushNow() })
        assertEquals(ErrorText.REFUSED, g.settings.get(Settings.K.PUSH_ERROR))
        g.settings.set(Settings.K.PUSH_ERROR, null)
        assertNull(io { g.session.patchPushNow() })
        assertEquals(ErrorText.REFUSED, g.settings.get(Settings.K.PUSH_ERROR))
    }

    /** A retried failure stays silent until the last try, which shows why and stops. */
    @Test fun lastTryShowsWhy() {
        reply(500, "{\"error\":\"down\"}")
        assertEquals(false, io { g.session.patchPushNow() })
        assertNull(g.settings.get(Settings.K.PUSH_ERROR))
        assertNull(io { g.session.patchPushNow(last = true) })
        assertEquals(ErrorText.SERVER_DOWN, g.settings.get(Settings.K.PUSH_ERROR))
    }

    /** Retry on the did-not-deliver banner says why the push address was not sent. */
    @Test fun retryTapSaysWhy() {
        reply(500, "{\"error\":\"down\"}")
        val vm = AppViewModel(app)
        vm.retryPush()
        waitFor { vm.message.value != null }
        assertEquals(ErrorText.text(UiText.UNABLE_TURN_ON_NOTIFICATIONS, ErrorText.SERVER_DOWN), vm.message.value)
    }

    /** Check again on a push address card sends the address again: still refused says so; accepted clears the card. */
    @Test fun checkAgainSendsTheAddressAgain() {
        g.settings.set(Settings.K.PUSH_ERROR, ErrorText.PUSH_NOT_SUPPORTED)
        reply(400, "{\"error\":\"push endpoint not allowed\"}")
        val vm = AppViewModel(app)
        vm.checkAgain(local = false)
        waitFor { vm.message.value != null }
        assertEquals(UiText.CHECK_STILL, vm.message.value)
        reply(200, "{}")
        vm.message.value = null
        vm.coolTaps.value = emptyMap() // past the 10 s grey time
        vm.checkAgain(local = true)
        waitFor { vm.message.value != null }
        assertNull(g.settings.get(Settings.K.PUSH_ERROR))
    }

    /** Check again and banner Retry grey for 10 s after a tap: a tap inside that time does nothing; Refresh and Try again use the same 10 s. */
    @Test fun checkAgainAndRetryGreyTenSeconds() {
        val vm = AppViewModel(app)
        assertEquals(10_000L, AppViewModel.TRY_AGAIN_GREY_MS)
        for (key in listOf(AppViewModel.CHECK_AGAIN_KEY, AppViewModel.RETRY_PUSH_KEY)) {
            assertEquals(true, vm.coolTap(key, 1_000_000))
            assertEquals(false, vm.coolTap(key, 1_009_999))
            assertEquals(true, vm.coolTap(key, 1_010_000))
        }
        // A real tap of each greys it: the second tap sends nothing.
        val calls = java.util.concurrent.atomic.AtomicInteger()
        app.fakeHttp = Interceptor { chain -> calls.incrementAndGet()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(400).message("x")
                .body("{\"error\":\"push endpoint not allowed\"}".toResponseBody("application/json".toMediaType())).build()
        }
        val v2 = AppViewModel(app)
        v2.retryPush(); waitFor { v2.message.value != null || calls.get() > 0 }; waitFor { v2.running.value.isEmpty() }
        v2.retryPush(); waitFor { v2.running.value.isEmpty() }
        assertEquals(1, calls.get())
        g.settings.set(Settings.K.PUSH_ERROR, ErrorText.PUSH_NOT_SUPPORTED)
        v2.checkAgain(local = true); waitFor { calls.get() > 1 }; waitFor { v2.running.value.isEmpty() }
        v2.checkAgain(local = true); waitFor { v2.running.value.isEmpty() }
        assertEquals(2, calls.get())
    }

    /** A 5xx is tried 3 times in all, 1 s then 3 s apart, then the reason shows. */
    @Test fun serverErrorTriedThreeTimes() {
        val calls = java.util.concurrent.atomic.AtomicInteger()
        app.fakeHttp = Interceptor { chain -> calls.incrementAndGet()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(502).message("x")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
        app.retrySleeps.clear()
        assertEquals(false, io { g.session.patchPushNow() })
        assertEquals(3, calls.get())
        assertEquals(listOf(1000L, 3000L), app.retrySleeps.toList())
    }

    /** A UnifiedPush probe the relay server does not confirm shows the cannot-receive card with why; a confirmed one clears it. */
    @Test fun probeConfirmFailureShowsWhy() {
        reply(500, "{\"error\":\"down\"}")
        io { g.session.confirmProbe("c".repeat(22)) }
        assertEquals(ErrorText.SERVER_DOWN, g.settings.get(Settings.K.PUSH_ERROR))
        reply(401, "{\"error\":\"wrong code\"}")
        io { g.session.confirmProbe("c".repeat(22)) }
        assertEquals(ErrorText.reason(ApiResult.Http(401, "wrong code")), g.settings.get(Settings.K.PUSH_ERROR))
        reply(200, "{}")
        io { g.session.confirmProbe("c".repeat(22)) }
        assertNull(g.settings.get(Settings.K.PUSH_ERROR))
        assertEquals(true, g.settings.flag(Settings.K.UP_VERIFIED, false))
    }

    /** A pairing message that failed in the background says "Unable to pair with" the device and why, once. */
    @Test fun pairSendFailureShowsOnce() {
        io { g.store.putPeer(Peer(id = "X".repeat(40), name = "Pixel 8")) }
        io { g.session.pairSendFailed("X".repeat(40), null) } // a timed-out pairing: nothing here
        assertNull(g.settings.get(Settings.K.PAIR_ERROR))
        io { g.session.pairSendFailed("X".repeat(40), ApiResult.Network) }
        val vm = AppViewModel(app)
        val job = kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { vm.showPairErrors() }
        try {
            waitFor { vm.message.value != null }
            assertEquals(ErrorText.text(UiText.unablePair("Pixel 8"), ErrorText.UNREACHABLE), vm.message.value)
            waitFor { g.settings.get(Settings.K.PAIR_ERROR) == null }
            assertNull(g.settings.get(Settings.K.PAIR_ERROR))
        } finally { job.cancel() }
    }
}
