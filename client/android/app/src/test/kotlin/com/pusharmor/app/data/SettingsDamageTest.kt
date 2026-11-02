package com.pusharmor.app.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferencesSerializer
import androidx.datastore.preferences.core.preferencesOf
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.store.PaDao
import com.pusharmor.store.PaDatabase
import com.pusharmor.store.StateEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/*
 * The security state lives in the database, so a damaged settings file resets only preferences. Each class has
 * its own Robolectric sandbox (its own instrumented package name): the settings DataStore is one instance per
 * sandbox and reads the file once, so no other class may have opened it.
 */

private fun ctx(): Context = ApplicationProvider.getApplicationContext<android.app.Application>()
private fun settingsFile(c: Context) = File(c.filesDir, "datastore/settings.preferences_pb").also { it.parentFile!!.mkdirs() }
private fun damage(c: Context) = settingsFile(c).writeBytes(byteArrayOf(0x0a, 0x7f, 0x01, 0x02, 0x03))
private fun dao(c: Context): PaDao = PaDatabase.open(c, name = null, multiInstance = false).dao()
private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.signedout"])
class DamageKeepsSignedOutTest {
    @Test fun damagedSettingsFileKeepsTheLoggedOutState() {
        val c = ctx(); val d = dao(c)
        io { d.putState(StateEntity("signed_out", "1")); d.putState(StateEntity("logout_pending", "1")) }
        damage(c)
        val s = Settings(c, d)
        assertTrue(s.flag(Settings.K.SIGNED_OUT, false))
        assertTrue(s.flag(Settings.K.LOGOUT_PENDING, false))
        assertEquals(true, runBlocking { s.data.first() }[Settings.K.SIGNED_OUT]) // the screens' snapshot too
        assertTrue(s.takeResetNotice()) // the file was read as damaged
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.removal"])
class DamageKeepsRemovalCheckTest {
    @Test fun damagedSettingsFileKeepsTheRemovalCheck() {
        val c = ctx(); val d = dao(c)
        io { d.putState(StateEntity("removal_check", "deleted")); d.putState(StateEntity("old_id", "A".repeat(40))) }
        damage(c)
        val s = Settings(c, d)
        assertEquals("deleted", s.get(Settings.K.REMOVAL_CHECK))
        assertEquals("A".repeat(40), s.get(Settings.K.OLD_ID))
        assertTrue(s.takeResetNotice()) // the file was read as damaged
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.notice"])
class DamageNoticeTest {
    @Test fun resetNoticeShowsOnce() {
        val c = ctx()
        damage(c)
        val s = Settings(c, dao(c))
        assertTrue(s.takeResetNotice())
        assertFalse(s.takeResetNotice())
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.move"])
class SettingsMoveTest {
    private fun read(c: Context): Preferences = runBlocking { PreferencesSerializer.readFrom(okio.Buffer().write(settingsFile(c).readBytes())) }

    /** An older version's file: its security state goes to the database and leaves the file; preferences stay. */
    @Test fun oldSecurityStateMovesToTheDatabase() {
        val c = ctx(); val d = dao(c)
        io { d.putState(StateEntity("push_type", "unifiedpush")) } // a value already in the database wins
        val old = preferencesOf(
            Settings.K.SIGNED_OUT to true, Settings.K.REMOVAL_CHECK to "removed", Settings.K.OLD_ID to "B".repeat(40),
            Settings.K.PUSH_TYPE to "fcm", Settings.K.PUSH_TOKEN to "tok", Settings.K.UP_P256DH to "pk", Settings.K.UP_AUTH to "au",
            Settings.K.UP_REGISTERED_AT to 123L, Settings.K.THEME to "dark",
        )
        val buf = okio.Buffer(); runBlocking { PreferencesSerializer.writeTo(old, buf) }
        settingsFile(c).writeBytes(buf.readByteArray())
        val s = Settings(c, d)
        assertEquals("1", io { d.state("signed_out") })
        assertEquals("removed", io { d.state("removal_check") })
        assertEquals("B".repeat(40), io { d.state("old_id") })
        assertEquals("unifiedpush", io { d.state("push_type") })
        assertEquals("pk", io { d.state("up_p256dh") }); assertEquals("au", io { d.state("up_auth") })
        assertEquals(123L, s.get(Settings.K.UP_REGISTERED_AT))
        assertTrue(s.flag(Settings.K.SIGNED_OUT, false))
        assertEquals("tok", s.get(Settings.K.PUSH_TOKEN))
        assertEquals("dark", s.get(Settings.K.THEME))
        val file = read(c)
        assertNull(file[Settings.K.SIGNED_OUT]); assertNull(file[Settings.K.UP_AUTH]); assertNull(file[Settings.K.OLD_ID])
        assertEquals("dark", file[Settings.K.THEME])
        assertFalse(s.takeResetNotice())
    }
}
