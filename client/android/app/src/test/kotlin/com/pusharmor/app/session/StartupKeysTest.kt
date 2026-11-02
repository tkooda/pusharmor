package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.Graph
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.store.PaDatabase
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
        assertEquals(Session.Start.SIGN_IN, g.session.startup(fromMainActivity = true))
        assertTrue(KeystoreKeyOps.present())
        g.keysOrNull!!.sign(byteArrayOf(1, 2, 3))
        assertArrayEquals(signPub, g.session.keysForSignIn())
    }

    /** Leftover keys with no sign-in in progress are deleted, and the cached keys go with them. */
    @Test fun leftoverKeysAreDeletedWithTheCache() = io {
        g.settings.set(Settings.K.SIGN_IN_KEYS, null)
        g.dao.self(); g.dbCreated = false // a database file from an earlier process
        g.keysOrNull = KeystoreKeyOps.createFresh()
        assertEquals(Session.Start.SIGN_IN, g.session.startup(fromMainActivity = true))
        assertFalse(KeystoreKeyOps.anyPresent())
        assertNull(g.keysOrNull)
    }

    /** A failed self read throws out of startup and leaves the keys alone. */
    @Test fun selfReadErrorKeepsKeys() = io {
        g.settings.set(Settings.K.SIGN_IN_KEYS, null)
        g.dao.self(); g.dbCreated = false
        KeystoreKeyOps.createFresh()
        g.db.openHelper.writableDatabase.execSQL("DROP TABLE self")
        assertThrows(Exception::class.java) { g.session.startup(fromMainActivity = true) }
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
        assertEquals(Session.Start.SIGN_IN, g2.session.startup(fromMainActivity = true))
        assertTrue(g2.dbCreated)
        assertTrue(KeystoreKeyOps.present())
    }
}
