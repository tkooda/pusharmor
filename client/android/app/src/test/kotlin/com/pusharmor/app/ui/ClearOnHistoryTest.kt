package com.pusharmor.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Message notifications are cleared while History is the resumed screen, not on other tabs or in the background. */
class ClearOnHistoryTest {
    @Test fun historyResumedClears() = assertTrue(clearsMessages("history", resumed = true))

    @Test fun otherTabsAndBackgroundLeaveNotificationsAlone() {
        for (r in listOf("send", "peers", "settings", null)) assertFalse(clearsMessages(r, resumed = true))
        assertFalse(clearsMessages("history", resumed = false))
    }

    @Test fun appRunsTheClearWhenHistoryIsResumed() {
        val app = java.io.File("src/main/kotlin/com/pusharmor/app/ui/MainActivity.kt").readText()
        assertTrue(app.contains("LaunchedEffect(route, resumed) { if (clearsMessages(route, resumed)) vm.g.notifier.cancelMessages() }"))
    }
}
