package com.pusharmor.app.ui

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.protocol.Peer
import com.pusharmor.store.HistoryEntity
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/** Sync deletions: with the setting on, the rows go only after the relay server took every del. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SyncDeletionsTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val sends = AtomicInteger()
    @Volatile private var status = 500
    private val peer = SoftwareKeyOps.generate()
    private val peerId = "C".repeat(40)

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.store.putPeer(Peer(id = peerId, platform = "android", signPub = B64url.encode(peer.signPub), encPub = B64url.encode(peer.encPub),
            pairingId = ByteArray(8), approved = true, approveVerified = true))
        g.dao.deleteAllHistory()
        app.fakeHttp = Interceptor { chain ->
            if (chain.request().url.encodedPath == "/v1/send") sends.incrementAndGet()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("x")
                .body((if (status == 200) "{\"r\":{\"$peerId\":\"sent\"}}" else "{}").toResponseBody("application/json".toMediaType())).build()
        }
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.dao.deleteAllHistory()
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    private fun row(msgId: String?) = io {
        g.dao.insertHistory(HistoryEntity(direction = "SENT", peerId = null, type = "text", content = "x", n = null, pairingId = null,
            at = 1, read = true, results = "{}", count = 1, msgId = msgId))
    }

    private fun count() = io { g.dao.historyRows((1L..1000L).toList()).size }

    private fun run(vm: AppViewModel, job: () -> kotlinx.coroutines.Job) {
        val j = job()
        val end = System.currentTimeMillis() + 5000
        while (!j.isCompleted && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
    }

    @Test fun workerFailureKeepsTheRowsAndShowsTheError() {
        val vm = AppViewModel(app)
        val ids = listOf(row("aaaa"), row(null))
        run(vm) { vm.deleteHistory(ids) }
        assertEquals(2, count())
        assertEquals("Unable to delete on your other devices.\nThe relay server is not working right now. Try again later.", vm.message.value)
        vm.message.value = null
        run(vm) { vm.deleteAllHistory() }
        assertEquals(2, count())
        assertEquals("Unable to delete on your other devices.\nThe relay server is not working right now. Try again later.", vm.message.value)
    }

    @Test fun successDeletesAfterTheSend() {
        val vm = AppViewModel(app)
        status = 200
        val ids = listOf(row("aaaa"), row("bbbb"))
        run(vm) { vm.deleteHistory(ids.take(1)) }
        assertEquals(1, sends.get())
        assertEquals(1, count())
        run(vm) { vm.deleteAllHistory() }
        assertEquals(2, sends.get())
        assertEquals(0, count())
        assertNull(vm.message.value)
    }

    @Test fun settingOffOrNoIdDeletesAtOnceWithNoSend() {
        val vm = AppViewModel(app)
        val noId = row(null)
        run(vm) { vm.deleteHistory(listOf(noId)) }
        g.settings.set(Settings.K.SYNC_DELETIONS, false)
        val withId = row("aaaa")
        run(vm) { vm.deleteHistory(listOf(withId)) }
        assertEquals(0, sends.get())
        assertEquals(0, count())
        assertNull(vm.message.value)
    }
}
