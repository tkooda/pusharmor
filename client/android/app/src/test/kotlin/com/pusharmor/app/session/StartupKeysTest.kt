package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.Graph
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.store.PaDatabase
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Startup with keys but no self row (section 9). Its own SDK gives it its own Robolectric sandbox: the
 * settings DataStore is one instance per sandbox, and SettingsCorruptTest needs one no TestApp has opened.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestApp::class)
class StartupKeysTest {
    private val g get() = ApplicationProvider.getApplicationContext<PaApp>().graph

    @Before fun keystore() = FakeAndroidKeyStore.install()
    @After fun done() = FakeAndroidKeyStore.remove()

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    /** A recreate or cold start mid sign-in keeps the keys the ticket is bound to, and they still sign. */
    @Test fun signInKeysSurviveStartup() = io {
        g.keysOrNull = null
        val signPub = g.session.keysForSignIn()
        assertEquals(Session.Start.SIGN_IN, g.session.startup())
        assertTrue(KeystoreKeyOps.present())
        g.keysOrNull!!.sign(byteArrayOf(1, 2, 3))
        assertArrayEquals(signPub, g.session.keysForSignIn())
    }

    /** A process death mid sign-in: the next process keeps the keys and signs in with the same public key. */
    @Test fun signInKeysSurviveProcessDeath() = io {
        g.dao.self(); g.keysOrNull = null
        val signPub = g.session.keysForSignIn()
        val g2 = Graph(ApplicationProvider.getApplicationContext<PaApp>())
        g2.keysOrNull = null // no cached keys in the new process
        assertEquals(Session.Start.SIGN_IN, g2.session.startup())
        assertTrue(KeystoreKeyOps.present())
        assertTrue(g2.settings.flag(Settings.K.SIGN_IN_KEYS, false))
        assertArrayEquals(signPub, g2.session.keysForSignIn())
    }

    /** Leftover keys with no sign-in in progress are deleted, and the cached keys go with them. */
    @Test fun leftoverKeysAreDeletedWithTheCache() = io {
        g.settings.set(Settings.K.SIGN_IN_KEYS, null)
        g.dao.self(); g.dbCreated = false // a database file from an earlier process
        g.keysOrNull = KeystoreKeyOps.createFresh()
        assertEquals(Session.Start.SIGN_IN, g.session.startup())
        assertFalse(KeystoreKeyOps.anyPresent())
        assertNull(g.keysOrNull)
    }

    /** A failed self read throws out of startup and leaves the keys alone. */
    @Test fun selfReadErrorKeepsKeys() = io {
        g.settings.set(Settings.K.SIGN_IN_KEYS, null)
        g.dao.self(); g.dbCreated = false
        KeystoreKeyOps.createFresh()
        g.db.openHelper.writableDatabase.execSQL("DROP TABLE self")
        assertThrows(Exception::class.java) { g.session.startup() }
        assertTrue(KeystoreKeyOps.present())
    }

    /** A corrupt database file that SQLite replaces with an empty one is not proof of "no self row". */
    @Test fun corruptDatabaseKeepsKeys() = io {
        val app = ApplicationProvider.getApplicationContext<PaApp>()
        g.settings.set(Settings.K.SIGN_IN_KEYS, null)
        g.dao.self()
        KeystoreKeyOps.createFresh()
        g.db.close()
        app.getDatabasePath(PaDatabase.NAME).writeBytes(ByteArray(4096) { 0x5a })
        val g2 = Graph(app)
        assertEquals(Session.Start.SIGN_IN, g2.session.startup())
        assertTrue(g2.dbCreated)
        assertTrue(KeystoreKeyOps.present())
    }

    private fun signedIn() {
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "A".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.settings.set(Settings.K.SIGNED_OUT, false)
        g.settings.set(Settings.K.BANNER, null)
    }

    /** A Keystore that fails on two starts, boots apart, shows the keys screen each time and deletes nothing. */
    @Test fun keystoreErrorOnTwoStartsKeepsKeys() = io {
        signedIn()
        FakeAndroidKeyStore.storeFault = true
        assertEquals(Session.Start.KEYS_UNAVAILABLE, g.session.startup())
        assertEquals(Session.Start.KEYS_UNAVAILABLE, g.session.startup())
        FakeAndroidKeyStore.storeFault = false
        assertEquals("A".repeat(40), g.dao.self()?.id)
        assertTrue(KeystoreKeyOps.present())
        assertNull(g.settings.get(Settings.K.BANNER))
    }

    /** A Keystore error on two starts mid sign-in keeps the keys and the sign-in mark, and the sign-in goes on with the same key. */
    @Test fun keystoreErrorMidSignInKeepsKeys() = io {
        g.dao.self(); g.dbCreated = false; g.keysOrNull = null
        val signPub = g.session.keysForSignIn()
        FakeAndroidKeyStore.storeFault = true
        assertEquals(Session.Start.KEYS_UNAVAILABLE, g.session.startup())
        assertEquals(Session.Start.KEYS_UNAVAILABLE, g.session.startup())
        FakeAndroidKeyStore.storeFault = false
        assertTrue(g.settings.flag(Settings.K.SIGN_IN_KEYS, false))
        assertTrue(KeystoreKeyOps.present())
        g.keysOrNull = null
        assertArrayEquals(signPub, g.session.keysForSignIn())
    }

    /** Keys that are listed but cannot sign stop at the keys screen; the account and the keys stay. */
    @Test fun unusableKeysShowKeysScreenAndKeepAccount() = io {
        signedIn()
        FakeAndroidKeyStore.keyFault = true
        assertEquals(Session.Start.KEYS_UNAVAILABLE, g.session.startup())
        FakeAndroidKeyStore.keyFault = false
        assertEquals("A".repeat(40), g.dao.self()?.id)
        assertTrue(KeystoreKeyOps.present())
    }

    /** Retry after the fault clears starts normally with the same keys. */
    @Test fun retryAfterFaultClearsStartsReady() = io {
        signedIn()
        val signPub = g.keysOrNull!!.signPub
        FakeAndroidKeyStore.keyFault = true
        assertEquals(Session.Start.KEYS_UNAVAILABLE, g.session.startup())
        FakeAndroidKeyStore.keyFault = false
        assertEquals(Session.Start.READY, g.session.startup())
        assertArrayEquals(signPub, g.keysOrNull!!.signPub)
    }
}
