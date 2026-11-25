package com.pusharmor.store

import androidx.room.testing.MigrationTestHelper
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MigrationTest {
    @get:Rule val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), PaDatabase::class.java)

    @Test fun migrate6To7KeepsDataAndAddsAppState() {
        helper.createDatabase("m7.db", 6).apply {
            execSQL("INSERT INTO history (direction, peer_id, type, received_at, read, results, count) VALUES ('received', 'p', 'text', 1, 0, '', 0)")
            close()
        }
        val db = helper.runMigrationsAndValidate("m7.db", 7, true, PaDatabase.MIGRATION_6_7)
        db.query("SELECT COUNT(*) FROM history").use { c -> c.moveToFirst(); assertEquals(1, c.getInt(0)) }
        db.execSQL("INSERT INTO app_state (k, v) VALUES ('signed_out', '1')")
        db.query("SELECT v FROM app_state WHERE k = 'signed_out'").use { c -> c.moveToFirst(); assertEquals("1", c.getString(0)) }
    }

    @Test fun migrate7To8KeepsPairingsWithNoWaitFrom() {
        helper.createDatabase("m8.db", 7).apply {
            execSQL("INSERT INTO pairing (peer_id, role, state, own_r, started_at, not_before, authorized, last_send_at) VALUES ('p', 'N', 'COMMITTED', zeroblob(32), 7, 0, 0, 0)")
            close()
        }
        val db = helper.runMigrationsAndValidate("m8.db", 8, true, PaDatabase.MIGRATION_7_8)
        db.query("SELECT started_at, wait_from FROM pairing").use { c -> c.moveToFirst(); assertEquals(7, c.getLong(0)); assertTrue(c.isNull(1)) }
    }

    @Test fun migrate8To9KeepsHistoryWithNoMessageId() {
        helper.createDatabase("m9.db", 8).apply {
            execSQL("INSERT INTO history (direction, peer_id, type, content, received_at, read, results, count) VALUES ('RECEIVED', 'p', 'text', 'hi', 5, 0, '', 1)")
            close()
        }
        val db = helper.runMigrationsAndValidate("m9.db", 9, true, PaDatabase.MIGRATION_8_9)
        db.query("SELECT content, msg_id FROM history").use { c -> c.moveToFirst(); assertEquals("hi", c.getString(0)); assertTrue(c.isNull(1)) }
    }

    @Test fun migrate9To10KeepsHistoryWithNoPendingDelete() {
        helper.createDatabase("m10.db", 9).apply {
            execSQL("INSERT INTO history (direction, peer_id, type, content, received_at, read, results, count, msg_id) VALUES ('SENT', null, 'text', 'hi', 5, 1, '{}', 1, 'abc')")
            close()
        }
        val db = helper.runMigrationsAndValidate("m10.db", 10, true, PaDatabase.MIGRATION_9_10)
        db.query("SELECT content, msg_id, del_req, del_ok FROM history").use { c ->
            c.moveToFirst(); assertEquals("hi", c.getString(0)); assertEquals("abc", c.getString(1)); assertTrue(c.isNull(2)); assertTrue(c.isNull(3))
        }
    }

    @Test fun migrate10To11KeepsPeersWithNoVersion() {
        helper.createDatabase("m11.db", 10).apply {
            execSQL("INSERT INTO peers (id, platform, created, approved, denied_by_me, approve_verified, approves_me, denies_me, list_after_verify, declined, " +
                "reachable, logged_out, logout_n, hidden, name, name_n, removed, missing, last_n, last_send_at, lock_screen, watch, hide_content) " +
                "VALUES ('p', 'ios', 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 'Phone', 0, 0, 0, 0, 0, 1, 1, 0)")
            close()
        }
        val db = helper.runMigrationsAndValidate("m11.db", 11, true, PaDatabase.MIGRATION_10_11)
        db.query("SELECT name, version FROM peers").use { c -> c.moveToFirst(); assertEquals("Phone", c.getString(0)); assertTrue(c.isNull(1)) }
    }

    @Test fun migrate11To12KeepsPeersAndDropsVersion() {
        helper.createDatabase("m12.db", 11).apply {
            execSQL("INSERT INTO peers (id, platform, created, approved, denied_by_me, approve_verified, approves_me, denies_me, list_after_verify, declined, " +
                "reachable, logged_out, logout_n, hidden, name, name_n, removed, missing, last_n, last_send_at, note, pair_again, lock_screen, watch, hide_content, " +
                "listening, show_content, version) " +
                "VALUES ('p', 'ios', 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 'Phone', 0, 0, 0, 0, 9, 'n', 1, 0, 1, 0, 0, 0, '0.0.54')")
            close()
        }
        val db = helper.runMigrationsAndValidate("m12.db", 12, true, PaDatabase.MIGRATION_11_12)
        db.query("SELECT COUNT(*) FROM peers").use { c -> c.moveToFirst(); assertEquals(1, c.getInt(0)) }
        db.query("SELECT name, last_send_at, note, pair_again, lock_screen, listening, show_content FROM peers").use { c ->
            c.moveToFirst(); assertEquals("Phone", c.getString(0)); assertEquals(9, c.getLong(1)); assertEquals("n", c.getString(2))
            assertEquals(1, c.getInt(3)); assertEquals(0, c.getInt(4)); assertEquals(0, c.getInt(5)); assertEquals(0, c.getInt(6))
        }
        db.query("SELECT * FROM peers").use { c -> assertEquals(-1, c.getColumnIndex("version")) }
    }
}
