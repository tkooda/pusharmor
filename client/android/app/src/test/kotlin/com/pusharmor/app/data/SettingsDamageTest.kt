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

/** A database that fails while [failing] is set, as a damaged or busy file does on the first start after an upgrade. */
private class FlakyDao(private val real: PaDao) : PaDao by real {
    @Volatile var failing = true
    override fun state(k: String): String? = if (failing) throw android.database.SQLException("io") else real.state(k)
    override fun putState(s: StateEntity) = if (failing) throw android.database.SQLException("io") else real.putState(s)
}

private fun writeOld(c: Context, p: Preferences) {
    val buf = okio.Buffer(); runBlocking { PreferencesSerializer.writeTo(p, buf) }
    settingsFile(c).writeBytes(buf.readByteArray())
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.deferred"])
class DeferredMoveTest {
    /** A deferred move: a value cleared since then stays cleared, and a later try moves the rest. */
    @Test fun clearedKeyDoesNotComeBackFromTheFile() {
        val c = ctx(); val real = dao(c); val d = FlakyDao(real)
        writeOld(c, preferencesOf(Settings.K.LOGOUT_PENDING to true, Settings.K.SIGNED_OUT to true))
        val s = Settings(c, d) // the move is deferred
        d.failing = false
        s.set(Settings.K.LOGOUT_PENDING, null)
        val s2 = Settings(c, real) // the next start
        assertNull(s2.get(Settings.K.LOGOUT_PENDING))
        assertTrue(s2.flag(Settings.K.SIGNED_OUT, false))
        assertEquals(s2.flag(Settings.K.SIGNED_OUT, false), runBlocking { s2.data.first() }[Settings.K.SIGNED_OUT])
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.oldid"])
class DeferredOldIdTest {
    /** A wipe before the deferred move keeps the old device id. */
    @Test fun wipeKeepsAnUnmovedOldId() {
        val c = ctx(); val real = dao(c); val d = FlakyDao(real)
        writeOld(c, preferencesOf(Settings.K.OLD_ID to "C".repeat(40), Settings.K.THEME to "dark"))
        val s = Settings(c, d)
        d.failing = false
        s.clearKeepingOldId()
        s.moveToDb() // the next startup check
        assertEquals("C".repeat(40), s.get(Settings.K.OLD_ID))
        assertNull(s.get(Settings.K.THEME))
    }
}

/** A database whose writes fail while reads work, as a full or read-only disk does. */
private class NoWriteDao(private val real: PaDao) : PaDao by real {
    override fun putState(s: StateEntity) = throw android.database.SQLException("disk full")
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], application = android.app.Application::class, instrumentedPackages = ["com.pusharmor.sandbox.nowrite"])
class DeferredMoveReadsFileTest {
    /** A move that cannot write leaves the state in the file, and reads still see it: a sign-in keeps its keys, a logout stays. */
    @Test fun deferredMoveKeepsSignInAndLogoutState() {
        val c = ctx(); val d = NoWriteDao(dao(c))
        writeOld(c, preferencesOf(Settings.K.SIGN_IN_KEYS to true, Settings.K.SIGNED_OUT to true, Settings.K.REMOVAL_CHECK to "removed"))
        val s = Settings(c, d)
        assertNull(io { d.state("sign_in_keys") }) // the move was deferred
        assertTrue(s.flag(Settings.K.SIGN_IN_KEYS, false))
        assertTrue(s.flag(Settings.K.SIGNED_OUT, false))
        assertEquals("removed", s.get(Settings.K.REMOVAL_CHECK))
        assertEquals(true, runBlocking { s.data.first() }[Settings.K.SIGN_IN_KEYS])
    }
}
