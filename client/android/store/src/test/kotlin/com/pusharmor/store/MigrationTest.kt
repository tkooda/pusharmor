package com.pusharmor.store

import androidx.room.testing.MigrationTestHelper
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MigrationTest {
    @get:Rule val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), PaDatabase::class.java)

    @Test fun migrate1To2KeepsPeersAndAddsPairAgainFalse() {
        helper.createDatabase("m.db", 1).apply {
            execSQL(
                "INSERT INTO peers (id, platform, created, approved, denied_by_me, approve_verified, approves_me, denies_me, list_after_verify, " +
                    "declined, reachable, paused, pause_n, hidden, name_n, removed, missing, last_n, last_send_at, lock_screen, watch, hide_content) " +
                    "VALUES ('p', 'chrome', 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0)",
            )
            close()
        }
        val db = helper.runMigrationsAndValidate("m.db", 2, true, PaDatabase.MIGRATION_1_2)
        db.query("SELECT platform, pair_again FROM peers WHERE id = 'p'").use { c ->
            c.moveToFirst()
            assertEquals("chrome", c.getString(0))
            assertEquals(0, c.getInt(1))
        }
    }

    @Test fun migrate2To3RenamesPausedToLoggedOut() {
        helper.createDatabase("m3.db", 2).apply {
            execSQL(
                "INSERT INTO peers (id, platform, created, approved, denied_by_me, approve_verified, approves_me, denies_me, list_after_verify, " +
                    "declined, reachable, paused, pause_n, hidden, name_n, removed, missing, last_n, last_send_at, pair_again, lock_screen, watch, hide_content) " +
                    "VALUES ('p', 'chrome', 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 7, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0)",
            )
            execSQL("INSERT INTO history (direction, peer_id, type, received_at, read, results, count) VALUES ('received', 'p', 'paused', 1, 0, '', 0)")
            execSQL("INSERT INTO history (direction, peer_id, type, received_at, read, results, count) VALUES ('received', 'p', 'resumed', 2, 0, '', 0)")
            close()
        }
        val db = helper.runMigrationsAndValidate("m3.db", 3, true, PaDatabase.MIGRATION_2_3)
        db.query("SELECT logged_out, logout_n FROM peers WHERE id = 'p'").use { c ->
            c.moveToFirst()
            assertEquals(1, c.getInt(0))
            assertEquals(7L, c.getLong(1))
        }
        db.query("SELECT type FROM history ORDER BY received_at").use { c ->
            c.moveToFirst(); assertEquals("logged_out", c.getString(0))
            c.moveToNext(); assertEquals("logged_in", c.getString(0))
        }
    }

    @Test fun migrate3To4AddsListeningTrue() {
        helper.createDatabase("m4.db", 3).apply {
            execSQL(
                "INSERT INTO peers (id, platform, created, approved, denied_by_me, approve_verified, approves_me, denies_me, list_after_verify, " +
                    "declined, reachable, logged_out, logout_n, hidden, name_n, removed, missing, last_n, last_send_at, pair_again, lock_screen, watch, hide_content) " +
                    "VALUES ('p', 'chrome', 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0)",
            )
            close()
        }
        val db = helper.runMigrationsAndValidate("m4.db", 4, true, PaDatabase.MIGRATION_3_4)
        db.query("SELECT platform, listening FROM peers WHERE id = 'p'").use { c ->
            c.moveToFirst()
            assertEquals("chrome", c.getString(0))
            assertEquals(1, c.getInt(1))
        }
    }

    @Test fun migrate4To5InvertsHideContent() {
        helper.createDatabase("m5.db", 4).apply {
            for ((id, hide) in listOf("a" to 1, "b" to 0)) execSQL(
                "INSERT INTO peers (id, platform, created, approved, denied_by_me, approve_verified, approves_me, denies_me, list_after_verify, " +
                    "declined, reachable, logged_out, logout_n, hidden, name_n, removed, missing, last_n, last_send_at, pair_again, lock_screen, watch, hide_content) " +
                    "VALUES ('$id', 'chrome', 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, $hide)",
            )
            close()
        }
        val db = helper.runMigrationsAndValidate("m5.db", 5, true, PaDatabase.MIGRATION_4_5)
        db.query("SELECT id, show_content FROM peers ORDER BY id").use { c ->
            c.moveToFirst(); assertEquals(0, c.getInt(1))
            c.moveToNext(); assertEquals(1, c.getInt(1))
        }
    }

    @Test fun migrate5To6KeepsHistoryAndAddsIndexes() {
        helper.createDatabase("m6.db", 5).apply {
            execSQL("INSERT INTO history (direction, peer_id, type, received_at, read, results, count) VALUES ('received', 'p', 'text', 1, 0, '', 0)")
            close()
        }
        val db = helper.runMigrationsAndValidate("m6.db", 6, true, PaDatabase.MIGRATION_5_6)
        db.query("SELECT COUNT(*) FROM history").use { c -> c.moveToFirst(); assertEquals(1, c.getInt(0)) }
        val names = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'history' ORDER BY name").use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }
        assertEquals(listOf("index_history_peer_id_pairing_id_n", "index_history_received_at"), names)
    }

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
}
