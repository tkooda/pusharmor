package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.net.ErrorText
import com.pusharmor.protocol.engine.ApiResult
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit

/** A removal signal wipes the keys only when one more GET /peers also gets 401 "unknown peer". */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class RemovalCheckTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val calls = mutableListOf<String>()

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    /** Answers each request with the next reply: a status and body, or null for no connection. */
    private fun script(vararg replies: Pair<Int, String>?) {
        var i = 0
        app.fakeHttp = Interceptor { chain ->
            calls += chain.request().method + " " + chain.request().url.encodedPath
            val r = replies[minOf(i++, replies.size - 1)] ?: throw IOException("offline")
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(r.first).message("x")
                .body(r.second.toResponseBody("application/json".toMediaType())).build()
        }
    }

    private val unknownPeer = 401 to "{\"error\":\"unknown peer\"}"

    private fun assertKept() {
        assertNotNull(g.dao.self())
        assertTrue(KeystoreKeyOps.present())
        assertNotNull(g.keysOrNull)
        assertNull(g.settings.get(Settings.K.BANNER))
    }

    private fun assertWiped(banner: String) {
        assertNull(g.dao.self())
        assertFalse(KeystoreKeyOps.anyPresent())
        assertNull(g.keysOrNull)
        assertEquals(banner, g.settings.get(Settings.K.BANNER))
        assertNull(g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** A 401 "unknown peer" that the check GET answers with the device list: kept, and the call reads as no connection. */
    @Test fun unknownPeerRefutedKeepsKeys() = io {
        script(unknownPeer, 200 to "{}")
        val r = g.client.send(mapOf("x" to "M"))
        assertEquals(ApiResult.Network, r)
        assertEquals("Unable to send.\nThe relay server could not be reached. Check your internet connection and try again.", ErrorText.of("Unable to send.", r))
        assertEquals(listOf("POST /v1/send", "GET /v1/peers"), calls)
        assertKept()
        assertNull(g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** A 401 "unknown peer" that the check GET also gets: wiped with the removed banner; the check's own 401 does not start another check. */
    @Test fun unknownPeerConfirmedWipes() = io {
        script(unknownPeer)
        val r = g.client.peers()
        assertTrue(r.isUnknownPeer)
        assertEquals(2, calls.size)
        assertWiped(Session.REMOVED)
    }

    /** A delete message from an approved device, confirmed: the deleted banner. */
    @Test fun deleteSignalConfirmedShowsDeleted() = io {
        script(unknownPeer)
        g.effects(true).selfRemoved(deleted = true)
        assertEquals(listOf("GET /v1/peers"), calls)
        assertWiped(Session.DELETED)
    }

    /** A remove about this device that the check GET refutes: nothing is wiped. */
    @Test fun removeSignalRefutedKeepsKeys() = io {
        script(200 to "{}")
        g.effects(true).selfRemoved(deleted = false)
        assertEquals(1, calls.size)
        assertKept()
        assertNull(g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** No connection for the check: keys kept and the check stored; with the relay server back, the next app open wipes. */
    @Test fun offlineCheckRunsAgainOnAppOpen() = io {
        script(unknownPeer, null)
        assertEquals(ApiResult.Network, g.client.peers())
        assertEquals(2, calls.size)
        assertKept()
        assertEquals("removed", g.settings.get(Settings.K.REMOVAL_CHECK))
        script(unknownPeer)
        g.session.onAppOpen(System.currentTimeMillis())
        assertEquals(3, calls.size)
        assertWiped(Session.REMOVED)
    }

    /** 401 "bad id" is a plain failure: no check, no wipe, the action line and the request-not-accepted line. */
    @Test fun badIdNeverStartsTheCheck() = io {
        script(401 to "{\"error\":\"bad id\"}")
        val r = g.client.peers()
        assertEquals(ApiResult.Http(401, "bad id"), r)
        assertEquals("Unable to refresh the device list.\nThe relay server did not accept the request. Update PushArmor and try again.", ErrorText.of("Unable to refresh the device list.", r))
        assertEquals(1, calls.size)
        assertKept()
        assertNull(g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** An app open while another thread holds the check does no app open work; the held check alone decides. */
    @Test fun appOpenDuringHeldCheckDoesNothing() = io {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        app.fakeHttp = Interceptor { chain ->
            calls += chain.request().method + " " + chain.request().url.encodedPath
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("x")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
        g.settings.set(Settings.K.REMOVAL_CHECK, "removed")
        g.settings.set(Settings.K.DIRECT_SHARE, false)
        val other = Thread { g.session.confirmRemoval() }
        other.start()
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        g.session.onAppOpen(System.currentTimeMillis())
        assertEquals(false, g.settings.get(Settings.K.DIRECT_SHARE)) // the open work (share sheet migration first) did not run
        assertEquals(listOf("GET /v1/peers"), calls)
        release.countDown()
        other.join(10_000)
        assertKept()
        assertNull(g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** Replies to the check GETs in turn; the first is a 401 clock skew whose PA-Epoch is an hour ahead. Returns each PA-Time sent. */
    private fun skewThen(vararg after: Pair<Int, String>): List<Long> {
        val times = mutableListOf<Long>()
        val epoch = System.currentTimeMillis() / 1000 + 3600
        val replies = listOf(401 to "{\"error\":\"clock skew\"}") + after
        var i = 0
        app.fakeHttp = Interceptor { chain ->
            calls += chain.request().method + " " + chain.request().url.encodedPath
            times += chain.request().header("PA-Time")!!.toLong()
            val r = replies[minOf(i++, replies.size - 1)]
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(r.first).message("x").header("PA-Epoch", epoch.toString())
                .body(r.second.toResponseBody("application/json".toMediaType())).build()
        }
        return times
    }

    /** A clock skew on the check GET: one retry with the corrected clock; its device list keeps the keys and clears the check. */
    @Test fun clockSkewThenListKeepsKeys() = io {
        val times = skewThen(200 to "{}")
        g.settings.set(Settings.K.REMOVAL_CHECK, "removed")
        assertFalse(g.session.confirmRemoval())
        assertEquals(listOf("GET /v1/peers", "GET /v1/peers"), calls)
        assertTrue(times[1] - times[0] > 3_000_000) // the retry is signed with the relay server's clock
        assertKept()
        assertNull(g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** A clock skew, then 401 "unknown peer" on the retry: wiped. */
    @Test fun clockSkewThenUnknownPeerWipes() = io {
        skewThen(unknownPeer)
        g.settings.set(Settings.K.REMOVAL_CHECK, "removed")
        assertTrue(g.session.confirmRemoval())
        assertEquals(2, calls.size)
        assertWiped(Session.REMOVED)
    }

    /** A second clock skew: no third GET; the keys and the check stay. */
    @Test fun clockSkewTwiceKeepsKeys() = io {
        skewThen(401 to "{\"error\":\"clock skew\"}")
        g.settings.set(Settings.K.REMOVAL_CHECK, "removed")
        assertFalse(g.session.confirmRemoval())
        assertEquals(2, calls.size)
        assertKept()
        assertEquals("removed", g.settings.get(Settings.K.REMOVAL_CHECK))
    }

    /** Two checks started at once: one GET runs, its 401 "unknown peer" wipes once, and the other check returns without a call. */
    @Test fun twoChecksAtOnceRunOneGet() = io {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        app.fakeHttp = Interceptor { chain ->
            synchronized(calls) { calls += chain.request().method + " " + chain.request().url.encodedPath }
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(401).message("x")
                .body("{\"error\":\"unknown peer\"}".toResponseBody("application/json".toMediaType())).build()
        }
        g.settings.set(Settings.K.REMOVAL_CHECK, "removed")
        val start = CyclicBarrier(2)
        val results = java.util.Collections.synchronizedList(mutableListOf<Boolean>())
        val threads = List(2) { Thread { start.await(); results += g.session.confirmRemoval() } }
        threads.forEach { it.start() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        val deadline = System.currentTimeMillis() + 10_000
        while (results.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(5)
        assertEquals(listOf(false), results.toList()) // the check that lost the race made no call and wiped nothing
        assertKept()
        release.countDown()
        threads.forEach { it.join(10_000) }
        assertEquals(listOf(false, true), results.toList())
        assertEquals(listOf("GET /v1/peers"), calls)
        assertWiped(Session.REMOVED)
    }
}
