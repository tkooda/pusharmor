package com.pusharmor.app.ui

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.session.Session
import com.pusharmor.store.SelfEntity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.runBlocking
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A failing tap handler shows a message instead of crashing the app. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class AppViewModelTest {
    @Volatile private var uncaught: Throwable? = null
    private var old: Thread.UncaughtExceptionHandler? = null

    @Before fun catchUncaught() { old = Thread.getDefaultUncaughtExceptionHandler(); Thread.setDefaultUncaughtExceptionHandler { _, e -> uncaught = e } }
    @After fun restore() { Thread.setDefaultUncaughtExceptionHandler(old) }

    private fun vm() = AppViewModel(ApplicationProvider.getApplicationContext<PaApp>())

    private fun waitFor(cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5000
        while (!cond() && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
    }

    /** A tap that throws shows its action line and "Try again." on the next line. */
    @Test fun ioErrorSetsMessage() {
        val vm = vm()
        val job = vm.io(UiText.UNABLE_DELETE_HISTORY) { throw IllegalStateException("boom") }
        waitFor { job.isCompleted }
        assertNull(uncaught)
        assertFalse(vm.busy.value)
        assertEquals("Unable to delete the history.\nTry again.", vm.message.value)
        // a full disk, another store error, and a Keystore fault each say why
        assertEquals("Storage is full. Free some space and try again.", AppViewModel.localReason(android.database.sqlite.SQLiteFullException("full")))
        assertEquals("PushArmor could not save its data on this device. Restart PushArmor and try again.",
            AppViewModel.localReason(android.database.sqlite.SQLiteException("io")))
        assertEquals("This device's security keys cannot be used right now. Restart the device and try again.",
            AppViewModel.localReason(java.security.KeyStoreException("ks")))
    }

    @Test fun onceErrorReleasesKey() {
        val vm = vm()
        vm.once("send", UiText.UNABLE_SEND) { throw IllegalStateException("boom") }
        waitFor { vm.running.value.isEmpty() && vm.message.value != null }
        assertNull(uncaught)
        assertEquals(emptySet<String>(), vm.running.value)
        assertEquals("Unable to send.\nTry again.", vm.message.value)
    }

    /** A send that reached a device posts its History row, so the main screen opens History there. */
    @Test fun sendReachedPostsHistoryRow() {
        val vm = vm()
        val ok = vm.sendResult(1, com.pusharmor.protocol.engine.SendFlow.Outcome(mapOf("a" to "sent"), 2, historyId = 7L)) { "Laptop" }
        assertEquals("Message sent to \"Laptop\"", ok.text)
        assertEquals(7L, vm.sent.value?.historyId)
        vm.sent.value = null
        val none = vm.sendResult(1, com.pusharmor.protocol.engine.SendFlow.Outcome(mapOf("a" to "not listening"), 2, historyId = 8L)) { "Laptop" }
        assertFalse(none.ok)
        assertNull(vm.sent.value)
        assertEquals("Unable to send to \"Laptop\".\nIt is set to send only. It does not receive messages.", none.text)
        // no result word for the one picked device reads as not ready yet; two picks keep the count
        val missing = vm.sendResult(1, com.pusharmor.protocol.engine.SendFlow.Outcome(emptyMap(), 2), only = "a") { "Laptop" }
        assertEquals("Unable to send to \"Laptop\".\nIt has not finished turning on notifications. Open PushArmor on it.", missing.text)
        assertEquals("Sent to 0 of 2 devices", vm.sendResult(2, com.pusharmor.protocol.engine.SendFlow.Outcome(mapOf("a" to "gone", "b" to "denied"), 2)) { "Laptop" }.text)
        assertEquals(listOf(1, 3, 4), listOf(5L, 9L, 6L).map { historyItemIndex(listOf(listOf(5L), listOf(9L, 6L)), it) })
        assertEquals(null, toggleOpenRow(5L, 5L))
        assertEquals(6L, toggleOpenRow(5L, 6L))
        assertEquals(5L, toggleOpenRow(null, 5L))
        assertEquals(listOf(5L), toggleSelected(emptyList(), 5L))
        assertEquals(listOf(5L, 6L), toggleSelected(listOf(5L), 6L))
        assertEquals(emptyList<Long>(), toggleSelected(listOf(5L), 5L))
        assertEquals("Delete 1 selected", deleteSelectedLabel(1))
        assertEquals("Delete 3 selected", deleteSelectedLabel(3))
        assertEquals("Delete 1 message?", deleteSelectedTitle(1))
        assertEquals("Delete 2 messages?", deleteSelectedTitle(2))
    }

    /** Robolectric has no AndroidKeyStore, so key generation fails as a broken Keystore would. */
    @Test fun keystoreFailureInSignInShowsMessage() {
        val vm = vm()
        vm.g.keysOrNull = null
        assertNull(runBlocking { vm.oauthUrl("apple", "register") })
        assertNull(runBlocking { vm.nonce("register") })
        assertNull(uncaught)
        assertEquals("Unable to start the login.\nThis device's security keys cannot be used right now. Restart the device and try again.", vm.message.value)
    }

    private fun <T> onIo(block: () -> T): T = runBlocking(kotlinx.coroutines.Dispatchers.IO) { block() }

    /** An App Link ticket with no sign-in started on this device is dropped. */
    @Test fun appLinkTicketWithNoPendingSignInIsDropped() {
        val vm = vm()
        vm.g.keysOrNull = null
        onIo { vm.g.store.wipeRegistration(); vm.g.settings.set(Settings.K.PENDING_PURPOSE, null) }
        val job = vm.onAppLinkTicket("t", "a@example.com") {}
        waitFor { job.isCompleted }
        assertNull(uncaught)
        assertNull(vm.message.value)
    }

    /** A logged-in device drops a register ticket even with a stale pending purpose. */
    @Test fun loggedInDeviceDropsRegisterTicket() {
        val vm = vm()
        vm.g.keysOrNull = null
        onIo {
            vm.g.dao.putSelf(SelfEntity(id = "A".repeat(40), accountPrefix = ByteArray(9), name = "t"))
            vm.g.settings.set(Settings.K.PENDING_PURPOSE, "register")
        }
        val job = vm.onAppLinkTicket("t", "a@example.com") {}
        waitFor { job.isCompleted }
        assertNull(vm.message.value)
        assertNull(onIo { vm.g.settings.get(Settings.K.PENDING_PURPOSE) })
    }

    /** A sign-in started on this device still takes its ticket. */
    @Test fun pendingSignInTakesAppLinkTicket() {
        val vm = vm()
        vm.g.keysOrNull = null
        onIo { vm.g.store.wipeRegistration(); vm.g.settings.set(Settings.K.PENDING_PURPOSE, "register") }
        val job = vm.onAppLinkTicket("t", "a@example.com") {}
        waitFor { job.isCompleted }
        assertEquals("Unable to log in.\n" + Session.NO_KEYS, vm.message.value) // reached register(), which needs keys
    }

    /** A send that throws (here: no keys) returns "Unable to send." and why instead of crashing the app. */
    @Test fun sendErrorGivesNotDone() {
        val vm = vm()
        vm.g.keysOrNull = null
        onIo { vm.g.dao.putSelf(SelfEntity(id = "A".repeat(40), accountPrefix = ByteArray(9), name = "t")) }
        val r = runBlocking { vm.send(listOf("B".repeat(40)), "hi", asText = true) }
        assertEquals("Unable to send.\nTry again.", r.text)
        assertFalse(r.ok)
    }

    /** Each pairing and device tap that fails names its own action on line 1. */
    @Test fun pairingTapsNameTheirAction() {
        val vm = vm()
        vm.g.keysOrNull = null
        val id = "P".repeat(40)
        onIo { vm.g.store.putPeer(com.pusharmor.protocol.Peer(id = id, name = "Laptop")) }
        waitFor { vm.peers.value.any { it.id == id } }
        fun line1(tap: () -> Unit): String? {
            vm.message.value = null
            tap()
            waitFor { vm.message.value != null && vm.running.value.isEmpty() && vm.pairingAgain.value.isEmpty() }
            return vm.message.value?.substringBefore('\n')
        }
        assertEquals("Unable to cancel pairing with \"Laptop\".", line1 { vm.cancelPairing(id) })
        assertEquals("Unable to pair with \"Laptop\".", line1 { vm.pair(id) })
        assertEquals("Unable to pair with \"Laptop\".", line1 { vm.reply(id) })
        assertEquals("Unable to pair with \"Laptop\".", line1 { vm.sendAgainPair(id) })
        assertEquals("Unable to pair with \"Laptop\".", line1 { vm.pairAgain(id) })
        assertEquals("Unable to confirm \"Laptop\".", line1 { vm.approve(id) })
        assertEquals("Unable to reject \"Laptop\".", line1 { vm.deny(id) })
        assertEquals("Unable to remove \"Laptop\".", line1 { vm.remove(id) })
        assertNull(uncaught)
    }

    /** A switch change never rewrites the message counter: counting and switching at once keeps every count. */
    @Test fun switchChangesKeepTheCounter() {
        val vm = vm()
        val id = "P".repeat(40)
        onIo { vm.g.store.putPeer(com.pusharmor.protocol.Peer(id = id)) }
        val counter = Thread { repeat(300) { vm.g.dao.bumpCounter(id) } }
        val switcher = Thread { repeat(300) { i -> vm.setPeerSwitch(id, lock = i % 2 == 0) } }
        counter.start(); switcher.start(); counter.join(); switcher.join()
        waitFor { vm.running.value.isEmpty() && !vm.busy.value }
        Thread.sleep(300)
        assertEquals(300L, onIo { vm.g.dao.counter(id) })
    }

    @Test fun historyViewFiltersAndGroupsInOnePass() {
        fun row(id: Long, peer: String?, dir: String, at: Long) =
            com.pusharmor.store.HistoryEntity(id, dir, peer, "text", "m$id", null, null, at, true, "", 1)
        val day = 86_400_000L
        val rows = listOf(row(4, "a", "RECEIVED", 3 * day + 5), row(3, "b", "SENT", 3 * day + 4), row(2, "a", "SENT", 2 * day + 5), row(1, null, "RECEIVED", day + 5))
        var named = 0
        val v = historyView(rows, com.pusharmor.app.notify.HistoryFilter.Chip.PeerChip("a", "A"), null) { named++; it.uppercase() }
        assertEquals(listOf(4L), v.shown.map { it.id })
        assertEquals(setOf(4L), v.shownIds)
        assertEquals(listOf(listOf(4L)), v.days.values.map { g -> g.map { it.id } })
        assertEquals(listOf(3L, 2L), historyView(rows, com.pusharmor.app.notify.HistoryFilter.Chip.All, "SENT") { it }.days.values.map { g -> g.single().id })
        assertEquals(4, v.chips.size) // All, A, B, Unknown
        assertEquals(2, named)
        // A chip with no rows falls back to All.
        assertEquals(com.pusharmor.app.notify.HistoryFilter.Chip.All, historyView(rows, com.pusharmor.app.notify.HistoryFilter.Chip.PeerChip("z", "Z"), null) { it }.eff)
    }
}
