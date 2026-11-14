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
}
