package com.pusharmor.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.store.SelfEntity
import androidx.work.WorkManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** foss with a seeded fcm push row: the build clears it and runs the distributor flow (section 5). */
@RunWith(AndroidJUnit4::class)
class FossFlavorRuleTest {
    @Test fun seededFcmPushIsCleared() {
        val g = (ApplicationProvider.getApplicationContext<PaApp>()).graph
        assertFalse(g.push.hasPlayServices)
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.settings.set(Settings.K.PUSH_TYPE, "fcm")
        g.settings.set(Settings.K.PUSH_TOKEN, "seeded")
        g.session.onAppOpen(System.currentTimeMillis())
        assertNull(g.settings.get(Settings.K.PUSH_TOKEN))
        assertFalse(g.settings.get(Settings.K.PUSH_TYPE) == "fcm")
        settle(g)
    }

    /**
     * I515: onAppOpen queued push PATCH jobs for the fake self row; their 401 "unknown peer" from the
     * relay server wipes the registration and the Keystore aliases. Wait (bounded) for that wipe here,
     * so it cannot land inside a later test (KeystoreInstrumentedTest sign: PrivateKey null).
     */
    private fun settle(g: Graph) {
        val end = System.currentTimeMillis() + 30_000
        while (g.dao.self() != null && System.currentTimeMillis() < end) Thread.sleep(200)
        Thread.sleep(2_000) // a replaced PATCH still on its way gets the same 401
        WorkManager.getInstance(g.app).cancelAllWork().result.get()
        g.store.wipeRegistration()
        KeystoreKeyOps.deleteBoth()
        g.keysOrNull = null
    }
}
