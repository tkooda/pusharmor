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
import org.junit.Assert.assertTrue
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
        assertEquals(1, count()) // the row with no id is deleted here only
        assertEquals("Unable to delete on your other devices.\nThe relay server is not working right now. Try again later.", vm.message.value)
        val kept = io { g.dao.history(ids[0])!! }
        assertEquals(peerId, kept.delReq)
        assertNull(kept.delOk)
        vm.message.value = null
        run(vm) { vm.deleteHistory(ids) }
        assertEquals(1, count())
        assertEquals("Unable to delete on your other devices.\nThe relay server is not working right now. Try again later.", vm.message.value)
    }

    @Test fun successDeletesAfterTheSend() {
        val vm = AppViewModel(app)
        status = 200
        val ids = listOf(row("aaaa"), row("bbbb"))
        run(vm) { vm.deleteHistory(ids.take(1)) }
        assertEquals(1, sends.get())
        assertEquals(1, count())
        run(vm) { vm.deleteHistory(ids.drop(1)) }
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

    /** The History age purge deletes here only: no del goes to the other devices, with Sync deletions on. */
    @Test fun agePurgeSendsNoDel() {
        status = 200
        g.settings.set(Settings.K.SYNC_DELETIONS, true)
        g.settings.set(Settings.K.HISTORY_DAYS, 14)
        row("aaaa")
        io { g.session.purgeHistory() }
        assertEquals(0, count())
        assertEquals(0, sends.get())
    }

    /** Del 1 taken, del 2 failed at the relay server: del 1's rows go, del 2's rows stay, one notice. */
    @Test fun aFailedDelKeepsOnlyItsRows() {
        val vm = AppViewModel(app)
        val ids = (1..300).map { B64url.encode(ByteArray(48).also { java.security.SecureRandom().nextBytes(it) }) }
        val chunks = com.pusharmor.protocol.InnerMessage.delChunks(ids)
        val rows = ids.map { row(it) }
        app.fakeHttp = Interceptor { chain ->
            val k = if (chain.request().url.encodedPath == "/v1/send") sends.incrementAndGet() else 0
            val ok = k != 2 && k != 3 && k != 4 // the second del and its two retries fail
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(if (ok) 200 else 500).message("x")
                .body((if (ok) "{\"r\":{\"$peerId\":\"sent\"}}" else "{}").toResponseBody("application/json".toMediaType())).build()
        }
        run(vm) { vm.deleteHistory(rows) }
        assertEquals(chunks[1].size, count())
        assertEquals(chunks.size + 2, sends.get())
        assertEquals("Unable to delete on your other devices.\nThe relay server is not working right now. Try again later.", vm.message.value)
    }

    private val peer2Id = "D".repeat(40)

    /** Adds a second target; each /v1/send answers every device it names with the word [words] holds for it ("sent" if none). */
    private fun twoDevices(words: Map<String, String>) {
        val k = SoftwareKeyOps.generate()
        io { g.store.putPeer(Peer(id = peer2Id, platform = "android", signPub = B64url.encode(k.signPub), encPub = B64url.encode(k.encPub),
            pairingId = ByteArray(8), approved = true, approveVerified = true)) }
        app.fakeHttp = Interceptor { chain ->
            val body = chain.request().body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() }.orEmpty()
            if (chain.request().url.encodedPath == "/v1/send") { sends.incrementAndGet(); asked.add(listOf(peerId, peer2Id).filter { body.contains(it) }) }
            val r = listOf(peerId, peer2Id).filter { body.contains(it) }.joinToString(",") { "\"$it\":\"${words[it] ?: "sent"}\"" }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("x")
                .body("{\"r\":{$r}}".toResponseBody("application/json".toMediaType())).build()
        }
    }
    private val asked = java.util.Collections.synchronizedList(ArrayList<List<String>>())

    /** One device took the del, one did not: the row stays, struck through, and a repeat asks only the device left. */
    @Test fun aRowStaysUntilEveryDeviceTookItAndARepeatAsksOnlyTheRest() {
        val vm = AppViewModel(app)
        twoDevices(mapOf(peer2Id to "failed:fcm-500"))
        val id = row("aaaa")
        run(vm) { vm.deleteHistory(listOf(id)) }
        val kept = io { g.dao.history(id)!! }
        assertEquals(setOf(peerId, peer2Id), PendingDeletes.ids(kept.delReq))
        assertEquals(setOf(peerId), PendingDeletes.ids(kept.delOk))
        assertEquals(listOf(listOf(peerId, peer2Id), listOf(peer2Id), listOf(peer2Id)), asked.toList()) // the first send and its two retries
        assertTrue(vm.message.value!!.startsWith("Unable to delete on "))
        asked.clear()
        twoDevices(emptyMap())
        run(vm) { vm.deleteHistory(listOf(id)) }
        assertEquals(listOf(listOf(peer2Id)), asked.toList())
        assertEquals(0, count())
    }

    /** A device removed since the delete leaves the pending set; with none left the row goes. */
    @Test fun aRemovedDeviceDropsOutOfPending() {
        val vm = AppViewModel(app)
        twoDevices(mapOf(peer2Id to "failed:fcm-500"))
        val id = row("aaaa")
        run(vm) { vm.deleteHistory(listOf(id)) }
        assertEquals(1, count())
        io { g.store.putPeer(g.store.peer(peer2Id)!!.copy(removed = true)) }
        run(vm) { vm.settlePendingDeletes() }
        assertEquals(0, count())
    }

    @Test fun notDeletedSubtextAndMissedList() {
        assertEquals("Not deleted on \"Phone\"", UiText.notDeletedOn(listOf("Phone")))
        assertEquals("Not deleted on 2 devices", UiText.notDeletedOn(listOf("Phone", "Tab")))
        assertEquals(setOf("b"), PendingDeletes.remaining(setOf("a", "b", "c"), setOf("a"), setOf("a", "b")))
        assertNull(PendingDeletes.join(emptySet()))
        assertEquals(emptySet<String>(), PendingDeletes.ids(null))
    }

    @Test fun deleteSelectedBodyFollowsSyncSetting() {
        assertEquals("This deletes the selected messages off this and other paired devices.", UiText.deleteSelectedBody(true))
        assertEquals("This deletes the selected messages off this device.", UiText.deleteSelectedBody(false))
    }
}
