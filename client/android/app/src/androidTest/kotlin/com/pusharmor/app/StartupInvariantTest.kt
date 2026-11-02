package com.pusharmor.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.session.Session
import com.pusharmor.store.SelfEntity
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore

/** Startup invariant (section 9) on a device: aliases without a self row (kept mid sign-in), a missing alias. */
@RunWith(AndroidJUnit4::class)
class StartupInvariantTest {
    private val g = (ApplicationProvider.getApplicationContext<PaApp>()).graph

    @Test fun aliasesWithoutSelfRowAreDeleted() {
        g.store.wipeRegistration()
        g.settings.set(Settings.K.SIGN_IN_KEYS, null)
        g.dbCreated = false // as a database file from an earlier process
        g.keysOrNull = KeystoreKeyOps.createFresh()
        assertEquals(Session.Start.SIGN_IN, g.session.startup(fromMainActivity = true))
        assertFalse(KeystoreKeyOps.anyPresent())
        assertNull(g.keysOrNull)
    }

    /** Keys made for a sign-in still in progress are kept and still sign. */
    @Test fun signInKeysWithoutSelfRowAreKept() {
        g.store.wipeRegistration()
        g.keysOrNull = null
        val signPub = g.session.keysForSignIn()
        assertEquals(Session.Start.SIGN_IN, g.session.startup(fromMainActivity = true))
        assertTrue(KeystoreKeyOps.present())
        g.keysOrNull!!.sign(byteArrayOf(1, 2, 3))
        assertArrayEquals(signPub, g.session.keysForSignIn())
    }

    @Test fun missingAliasTakesSelfRemovedPathAndKeepsOldId() {
        KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "A".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KeystoreKeyOps.ENC)
        assertEquals(Session.Start.SIGN_IN, g.session.startup(fromMainActivity = true))
        assertEquals("A".repeat(40), g.settings.get(Settings.K.OLD_ID))
        assertEquals(Session.LOST_KEYS, g.settings.get(Settings.K.BANNER))
        assertFalse(KeystoreKeyOps.anyPresent())
    }
}
