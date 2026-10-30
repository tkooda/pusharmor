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
}
