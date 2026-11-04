package com.pusharmor.app.ui

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.PairRole
import com.pusharmor.protocol.PairState
import com.pusharmor.protocol.engine.PairingRow
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
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

/** The Devices screen calls the relay server when it opens and on a user action only; an idle open screen calls nothing. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class DevicesIdleTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val calls = AtomicInteger()
    private val peer = "C".repeat(40)

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        // every relay server call is counted and fails at once (500: no retry wait), so the pairing keeps waiting
        app.fakeHttp = Interceptor { chain ->
            calls.incrementAndGet()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(500).message("x")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
        // a device this one approved, still waiting on its approve, with an expired pairing:
        // each timeout check while the screen is open would send the approve again
        val day = 86_400_000L
        g.store.putPeer(Peer(id = peer, name = "Laptop", signPub = "s", encPub = "e", pairingId = ByteArray(16), approved = true,
            storedApprove = "{}", storedApproveName = "t"))
        g.store.putPairing(PairingRow(peerId = peer, role = PairRole.N, state = PairState.COMMITTED, r = ByteArray(32), cN = ByteArray(32),
            startedAt = System.currentTimeMillis() - 30 * day))
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.store.pairing(peer)?.let { g.store.deletePairing(peer) }
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    /** Lets the work a call started on the IO threads finish. */
    private fun settle() = Thread.sleep(200)

    @Test fun idleDevicesScreenMakesNoRelayCall() {
        val owner = androidx.lifecycle.ViewModelStore()
        val vm = androidx.lifecycle.ViewModelProvider(owner, androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.getInstance(app))[AppViewModel::class.java]
        val ticks = AtomicInteger()
        runBlocking(Dispatchers.Default) {
            // the open check runs; then 20 ticks of 30 s each: 10 minutes open, with no user action
            val open = launch {
                devicesScreenOpen(vm, tick = {
                    if (ticks.get() == 0) { settle(); calls.set(0) } // the calls of the open itself are allowed
                    if (ticks.get() >= 20) awaitCancellation()
                    ticks.incrementAndGet()
                }) { settle() }
            }
            while (ticks.get() < 20) Thread.sleep(10)
            settle()
            open.cancel()
        }
        owner.clear()
        assertEquals(20, ticks.get())
        assertEquals("relay server calls while the Devices screen sat idle", 0, calls.get())
    }
}
