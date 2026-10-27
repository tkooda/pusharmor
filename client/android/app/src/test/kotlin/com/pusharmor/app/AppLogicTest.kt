package com.pusharmor.app

import android.net.Uri
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.notify.HistoryFilter.Chip
import com.pusharmor.app.notify.Notifier
import com.pusharmor.app.notify.Policy
import com.pusharmor.app.ui.AuthLinkActivity
import com.pusharmor.app.ui.CodeInput
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

    @Test fun ticketExtrasOnlyThroughTheAuthHop() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        // an exported entry: any app can start MainActivity with these extras
        val direct = android.content.Intent(ctx, com.pusharmor.app.ui.MainActivity::class.java).putExtra("ticket", "x").putExtra("email", "evil")
        assertNull(com.pusharmor.app.ui.MainActivity.authExtras(direct))
        val hop = AuthLinkActivity.forward(ctx, "t1", "a@b.com")
        assertEquals("t1" to "a@b.com", com.pusharmor.app.ui.MainActivity.authExtras(hop))
    }
}
