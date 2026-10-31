package com.pusharmor.app

import android.net.Uri
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.notify.HistoryFilter.Chip
import com.pusharmor.app.notify.Notifier
import com.pusharmor.app.notify.Policy
import com.pusharmor.app.session.Session
import com.pusharmor.app.ui.AppViewModel
import com.pusharmor.app.ui.AuthLinkActivity
import com.pusharmor.app.ui.CodeInput
import com.pusharmor.app.ui.ShareActivity
import com.pusharmor.app.ui.pairingScrollTop
import com.pusharmor.app.ui.platformIcon
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.app.notify.AppEffects
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class AppLogicTest {
    @Test fun cliPlatformLabelAndIcon() {
        assertEquals("Command line", AppEffects.platformLabel("cli"))
        assertEquals(PaIcons.Terminal, platformIcon("cli"))
        assertEquals(PaIcons.Devices, platformIcon("other"))
    }

    @Test fun lockScreenWatchHidePolicy() {
        // effective = main AND peer
        assertFalse(Policy.of(true, true, true, true, false, false).privateOnLockScreen)
        assertTrue(Policy.of(false, true, true, true, false, false).privateOnLockScreen)
        assertTrue(Policy.of(true, false, true, true, false, false).privateOnLockScreen)
        assertTrue(Policy.of(true, true, true, false, false, false).localOnly)
        assertTrue(Policy.of(true, true, false, true, false, false).localOnly)
        // Always hide (main or peer) wins over lock screen and watch
        val h = Policy.of(false, false, true, true, false, true)
        assertTrue(h.hideAll); assertFalse(h.privateOnLockScreen)
        assertTrue(Policy.of(true, true, true, true, true, false).hideAll)
        // main off greys the per-peer switches
        assertFalse(Policy.peerSwitchEnabled(false))
    }

    @Test fun peersScrollTopOnlyWhenPairingGrows() {
        assertTrue(pairingScrollTop(0, 1, aiming = false))
        assertTrue(pairingScrollTop(1, 2, aiming = false))
        assertFalse(pairingScrollTop(2, 1, aiming = false)) // a card left: keep the place
        assertFalse(pairingScrollTop(1, 1, aiming = false))
        assertFalse(pairingScrollTop(0, 1, aiming = true)) // a highlight scroll is still due
    }

    @Test fun historyFilterChips() {
        val one = listOf(HistoryFilter.Row("a", true), HistoryFilter.Row("a", false))
        assertEquals(listOf<Chip>(Chip.All), HistoryFilter.chips(one) { it }) // peer chips hidden with one peer
        val rows = listOf(HistoryFilter.Row("a", true), HistoryFilter.Row("b", true), HistoryFilter.Row("a", false), HistoryFilter.Row(null, true))
        val chips = HistoryFilter.chips(rows) { it.uppercase() }
        assertEquals(listOf(Chip.All, Chip.PeerChip("a", "A"), Chip.PeerChip("b", "B"), Chip.Unknown), chips)
        // a peer chip shows received rows only
        assertEquals(1, rows.count { HistoryFilter.matches(it, Chip.PeerChip("a", "A")) })
        assertEquals(1, rows.count { HistoryFilter.matches(it, Chip.Unknown) })
        // Unknown only with an Unknown row; filter resets to All with no rows left
        assertFalse(HistoryFilter.chips(rows.dropLast(1)) { it }.contains(Chip.Unknown))
        assertEquals(Chip.All, HistoryFilter.effective(rows.dropLast(1), Chip.Unknown))
        // a sent row has no peer id and is not Unknown
        val sent = HistoryFilter.Row(null, false)
        assertFalse(HistoryFilter.chips(listOf(HistoryFilter.Row("a", true), sent)) { it }.contains(Chip.Unknown))
        assertFalse(HistoryFilter.matches(sent, Chip.Unknown))
    }

    @Test fun shareDirectTargetOnlyFromAllSet() {
        val all = listOf("a", "b")
        assertEquals("a", ShareActivity.directTarget("a", all)) // shortcut id in All: preselected, still waits for the Send tap
        assertNull(ShareActivity.directTarget("hidden", all)) // not in All: picker
        assertNull(ShareActivity.directTarget(null, all))
        assertEquals("a", ShareActivity.directTarget(null, listOf("a"))) // single All peer (Q160 C)
        assertEquals("a", ShareActivity.directTarget("hidden", listOf("a")))
        assertNull(ShareActivity.directTarget("hidden", emptyList()))
    }

    @Test fun shareOnlyWhenSignedIn() {
        assertTrue(ShareActivity.canShare(registered = true, signedOut = false))
        assertFalse(ShareActivity.canShare(registered = true, signedOut = true)) // logged out keeps its keys and self row
        assertFalse(ShareActivity.canShare(registered = false, signedOut = false))
    }

    @Test fun shareIgnoresPeerExtra() {
        val i = android.content.Intent().putExtra("peer", "hidden")
        val id = i.getStringExtra(androidx.core.content.pm.ShortcutManagerCompat.EXTRA_SHORTCUT_ID)
        assertNull(ShareActivity.directTarget(id, listOf("a", "b")))
    }

    @Test fun codeEntry() {
        assertEquals("7KQM9X", CodeInput.clean("7kqm9x"))
        assertEquals("011011", CodeInput.clean("OIL0il"))
        assertEquals("7KQM9X", CodeInput.clean("7K-QM 9X!"))
        assertEquals("ABC", CodeInput.clean("abc"))
        assertEquals("7KQM9X", CodeInput.fromPaste("Your code: 7KQ-M9X."))
        assertEquals("7KQM9X", CodeInput.fromPaste("7KQ M9X"))
        assertNull(CodeInput.fromPaste("no code here at all"))
    }

    @Test fun appLinkTicketFromFragmentOrQuery() {
        assertEquals("t1" to "a@b.com", AuthLinkActivity.parse(Uri.parse("https://pusharmor.com/auth/android#ticket=t1&email=a%40b.com")))
        assertEquals("t2" to "c@d.com", AuthLinkActivity.parse(Uri.parse("https://pusharmor.com/auth/android?ticket=t2&email=c@d.com")))
        assertEquals(null to null, AuthLinkActivity.parse(Uri.parse("https://evil.example/auth/android?ticket=t")))
    }

    @Test fun channelIdsRandomPerInstallAndTagsDistinct() {
        assertNotEquals(Notifier.randomChannelId(), Notifier.randomChannelId())
        assertEquals(22, Notifier.randomChannelId().length)
        assertTrue(Notifier.pairId("qtqwAJuYP9_Yd8FBzzto5w") >= 0)
        assertEquals(3, setOf(Notifier.TAG_MSG, Notifier.TAG_NOTICE, Notifier.TAG_PAIR).size)
    }

    @Test fun spentIntentIsNotReplayed() {
        val hist = android.content.Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY
        assertTrue(com.pusharmor.app.ui.MainActivity.shouldHandle(false, 0))
        assertFalse(com.pusharmor.app.ui.MainActivity.shouldHandle(true, 0))
        assertFalse(com.pusharmor.app.ui.MainActivity.shouldHandle(false, hist))
        assertFalse(com.pusharmor.app.ui.MainActivity.shouldHandle(false, hist or android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        assertTrue(com.pusharmor.app.ui.MainActivity.shouldHandle(false, android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @Test fun ticketExtrasOnlyThroughTheAuthHop() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        // an exported entry: any app can start MainActivity with these extras
        val direct = android.content.Intent(ctx, com.pusharmor.app.ui.MainActivity::class.java).putExtra("ticket", "x").putExtra("email", "evil")
        assertNull(com.pusharmor.app.ui.MainActivity.authExtras(direct))
        val hop = AuthLinkActivity.forward(ctx, "t1", "a@b.com")
        assertEquals("t1" to "a@b.com", com.pusharmor.app.ui.MainActivity.authExtras(hop))
    }

    @Test fun routeAndPeerExtrasOnlyThroughTheOpenAlias() {
        val main = com.pusharmor.app.ui.MainActivity
        assertEquals("history", main.safeRoute("history"))
        assertNull(main.safeRoute("nope"))
        assertNull(main.safeRoute(null))
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val direct = android.content.Intent(ctx, com.pusharmor.app.ui.MainActivity::class.java).putExtra("route", "send").putExtra("peer", "p")
        assertNull(main.ownExtras(direct))
        val own = main.openIntent(ctx, "send").putExtra("peer", "p")
        assertEquals("p" to "send", main.ownExtras(own))
        assertEquals("p" to null, main.ownExtras(main.openIntent(ctx, "bogus").putExtra("peer", "p")))
    }

    @Test fun pendingRouteChangeNotifiesCompose() {
        // A notification tap while the app is open must recompose the effect that navigates (I401).
        var changed = false
        val h = androidx.compose.runtime.snapshots.Snapshot.registerApplyObserver { _, _ -> changed = true }
        try {
            com.pusharmor.app.ui.MainActivity.pendingRoute = "history"
            androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
            assertTrue(changed)
        } finally {
            h.dispose()
            com.pusharmor.app.ui.MainActivity.pendingRoute = null
        }
    }

    @Test fun unifiedPushMessageRunsInAnExpeditedJob() {
        // onMessage hands off to WorkManager, not a thread the process can lose once it returns (I404).
        val m = com.pusharmor.app.work.Work.upPushRequest(null, "abc").workSpec
        assertTrue(m.expedited)
        assertEquals(com.pusharmor.app.work.UpPushWorker::class.java.name, m.workerClassName)
        assertEquals("abc", m.input.getString("m"))
        assertNull(m.input.getString("probe"))
        val p = com.pusharmor.app.work.Work.upPushRequest("code1", null).workSpec
        assertEquals("code1", p.input.getString("probe"))
        assertNull(p.input.getString("m"))
    }

    @Test fun unifiedPushPayloadIsAsciiAndFitsTheJobInput() {
        // A non-ASCII 4096-byte payload would cross the 10 KB Data limit as U+FFFD and crash onMessage (I407).
        assertTrue(runCatching { com.pusharmor.app.work.Work.upPushRequest(null, "\uFFFD".repeat(4096)) }.isFailure)
        assertNull(com.pusharmor.app.push.UpService.text(ByteArray(4096) { 0xC3.toByte() }))
        assertNull(com.pusharmor.app.push.UpService.text("ab\u00e9".toByteArray()))
        assertNull(com.pusharmor.app.push.UpService.text(ByteArray(0)))
        assertNull(com.pusharmor.app.push.UpService.text(ByteArray(4097) { 'a'.code.toByte() }))
        val max = com.pusharmor.app.push.UpService.text(ByteArray(4096) { '~'.code.toByte() })!!
        assertEquals(max, com.pusharmor.app.work.Work.upPushRequest(null, max).workSpec.input.getString("m"))
    }

    @Test fun selfNeverShowsAsAPeer() {
        // peers can emit before self: the own device must not show as a peer for that frame (critic14 #8)
        val ps = listOf(com.pusharmor.protocol.Peer(id = "me", platform = "android", created = 1),
            com.pusharmor.protocol.Peer(id = "b", platform = "android", created = 2))
        assertEquals(emptyList<com.pusharmor.protocol.Peer>(), com.pusharmor.app.ui.others(ps, null))
        assertEquals(listOf("b"), com.pusharmor.app.ui.others(ps, "me").map { it.id })
    }

    @Test fun unifiedPushJobNeverFailsTheChain() {
        // APPEND_OR_REPLACE: one FAILED job would fail every push queued behind it (critic14 #4).
        val r = kotlinx.coroutines.runBlocking { com.pusharmor.app.work.Work.neverFail { throw IllegalStateException("onFail threw") } }
        assertEquals(androidx.work.ListenableWorker.Result.success(), r)
    }

    @Test fun keystoreEcdhFailureIsCryptoExceptionAndPushPostsOneNotice() {
        val e = runCatching { com.pusharmor.app.keys.KeystoreKeyOps.wrap<ByteArray> { throw java.security.ProviderException("keystore") } }.exceptionOrNull()
        assertTrue(e is com.pusharmor.crypto.CryptoException)
        var notices = 0
        com.pusharmor.app.push.PushDispatcher.guard({ notices++ }) { throw java.security.ProviderException("keystore") }
        assertEquals(1, notices)
        com.pusharmor.app.push.PushDispatcher.guard({ notices++ }) {}
        assertEquals(1, notices)
    }

    private fun source(path: String) = java.io.File("src/main/kotlin/com/pusharmor/app/$path").readText()

    @Test fun shareNeverSendsOnItsOwn() {
        // Another app can start ShareActivity: it only hands the text to SendScreen, which sends on the Send tap alone (I445).
        val share = source("ui/ShareActivity.kt")
        assertTrue(share.contains("SendScreen("))
        assertFalse(Regex("""\bsend\(""").containsMatchIn(share))
        val main = source("ui/MainScreens.kt")
        val sends = Regex("""vm\.send\(""").findAll(main).map { it.range.first }.toList()
        assertEquals(1, sends.size)
        val screen = main.indexOf("fun SendScreen(")
        val button = main.indexOf("GreenButton(onClick", screen)
        assertTrue(screen in 0 until button && sends[0] > button && sends[0] < main.indexOf("text = UiText.sendLabel", button))
    }

    @Test fun lastSendSelectionNeverBlocksTheMainThread() {
        // The Send screen reads and saves its last selection on the main thread: only suspending DataStore calls (I434).
        for (name in listOf("lastSendTo", "saveSendTo")) {
            val m = com.pusharmor.app.data.Settings::class.java.methods.single { it.name == name }
            assertEquals(kotlin.coroutines.Continuation::class.java, m.parameterTypes.last())
        }
        val settings = source("data/Settings.kt")
        val body = settings.substring(settings.indexOf("suspend fun lastSendTo"), settings.indexOf("fun flag("))
        assertFalse(body.contains("runBlocking"))
        val main = source("ui/MainScreens.kt")
        val screen = main.substring(main.indexOf("fun SendScreen("), main.indexOf("private fun TypeCaption("))
        assertFalse(screen.contains("LAST_SEND_TO") || screen.contains("runBlocking"))
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val s = com.pusharmor.app.data.Settings(ctx)
        kotlinx.coroutines.runBlocking { s.saveSendTo(listOf("a", "b")) }
        assertEquals("a,b", kotlinx.coroutines.runBlocking { s.lastSendTo() })
    }

    @Test fun removedOrLoggedOutWhileOpenLeavesTheSignedInScreens() {
        assertTrue(AppViewModel.needsReboot(Session.Start.READY, selfPresent = false, signedOut = false)) // device removed
        assertTrue(AppViewModel.needsReboot(Session.Start.READY, selfPresent = true, signedOut = true)) // logged out
        assertFalse(AppViewModel.needsReboot(Session.Start.READY, selfPresent = true, signedOut = false))
        assertFalse(AppViewModel.needsReboot(Session.Start.SIGNED_OUT, selfPresent = true, signedOut = true))
        assertFalse(AppViewModel.needsReboot(Session.Start.SIGN_IN, selfPresent = false, signedOut = false))
        assertFalse(AppViewModel.needsReboot(null, selfPresent = false, signedOut = false))
    }
}
