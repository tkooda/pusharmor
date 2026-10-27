package com.pusharmor.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.store.SelfEntity
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
    }
}
