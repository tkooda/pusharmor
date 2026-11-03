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
