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
}
