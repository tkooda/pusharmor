package com.pusharmor.store

import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Archived accounts. The live tables hold the active account; an inactive account's rows are copied, by its
 * account id (the 12-char prefix of its peer id), into an arch_ table of the same database, each made from its
 * live table's columns. The archive keeps no plain email: arch_self holds a hash of it for matching. Settings kept outside the
 * database ride along as encoded strings in arch_prefs. Device-wide app_state keys never move.
 */
class Slots(private val db: PaDatabase) {
    companion object {
        /** The tables that belong to one account. */
        val TABLES = listOf("self", "peers", "pairing", "pairing_cap", "replay", "allow_set", "history")
        private const val STATE = "app_state"
        private const val PREFS = "arch_prefs"

        /** The archive's stand-in for an address: hex of sha256("PA-ACCT1\n" + trimmed lower case address). */
        fun emailHash(email: String): String =
            java.security.MessageDigest.getInstance("SHA-256").digest(("PA-ACCT1\n" + email.trim().lowercase()).toByteArray())
                .joinToString("") { "%02x".format(it) }
    }

    private val sql: SupportSQLiteDatabase get() = db.openHelper.writableDatabase

    private fun exists(t: String): Boolean =
        sql.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", arrayOf(t)).use { it.moveToFirst() }

    private fun columns(t: String): List<String> =
        sql.query("PRAGMA table_info(`$t`)").use { c -> buildList { while (c.moveToNext()) add(c.getString(c.getColumnIndexOrThrow("name"))) } }

    /** Makes arch_[t] (account, then the columns of [t]) and adds any column a newer schema gave [t]. */
    private fun ensure(t: String) {
        sql.execSQL("CREATE TABLE IF NOT EXISTS `arch_$t` AS SELECT '' AS account, * FROM `$t` WHERE 0")
        val have = columns("arch_$t").toSet()
        for (c in columns(t)) if (c !in have) sql.execSQL("ALTER TABLE `arch_$t` ADD COLUMN `$c`")
    }

    /** Columns of [t] its archive also has. */
    private fun common(t: String): String {
        val have = columns("arch_$t").toSet()
        return columns(t).filter { it in have }.joinToString(",") { "`$it`" }
    }

    private fun marks(keys: List<String>) = keys.joinToString(",", "(", ")") { "?" }

    /** The archived account whose email is [email] (lower case), other than [except]. */
    fun accountFor(email: String, except: String?): String? {
        if (!exists("arch_self")) return null
        hashPlain()
        return sql.query("SELECT account FROM arch_self WHERE email = ? AND account != ? LIMIT 1", arrayOf(emailHash(email), except ?: "")).use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    }

    /** Turns a plain address an earlier version left in arch_self into its hash. */
    private fun hashPlain() {
        val plain = sql.query("SELECT account, email FROM arch_self WHERE email LIKE '%@%'").use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0) to c.getString(1)) }
        }
        for ((a, e) in plain) sql.execSQL("UPDATE arch_self SET email = ? WHERE account = ?", arrayOf(emailHash(e), a))
    }

    fun has(account: String): Boolean =
        exists("arch_self") && sql.query("SELECT 1 FROM arch_self WHERE account = ?", arrayOf(account)).use { it.moveToFirst() }

    /** Copies the active account out to the archive of [account] (replacing any older copy), in one transaction. */
    fun archive(account: String, stateKeys: List<String>, prefs: Map<String, String>) = db.runInTransaction<Unit> {
        drop(account)
        for (t in TABLES) {
            ensure(t)
            val cols = common(t)
            sql.execSQL("INSERT INTO `arch_$t` (account,$cols) SELECT ?,$cols FROM `$t`", arrayOf(account))
        }
        hashPlain()
        ensure(STATE)
        sql.execSQL("INSERT INTO `arch_$STATE` (account,k,v) SELECT ?,k,v FROM $STATE WHERE k IN ${marks(stateKeys)}", (listOf(account) + stateKeys).toTypedArray())
        sql.execSQL("CREATE TABLE IF NOT EXISTS $PREFS (account TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL)")
        for ((k, v) in prefs) sql.execSQL("INSERT INTO $PREFS (account,k,v) VALUES (?,?,?)", arrayOf(account, k, v))
    }

    /**
     * Replaces the active account with the archive of [account] (or clears it for a new account, [account] null)
     * in one transaction; the archive itself stays until [drop]. Returns the archived settings.
     */
    fun load(account: String?, stateKeys: List<String>): Map<String, String> = db.runInTransaction<Map<String, String>> {
        sql.execSQL("UPDATE pairing SET own_r = zeroblob(32)")
        for (t in TABLES) {
            sql.execSQL("DELETE FROM `$t`")
            if (account != null && exists("arch_$t")) {
                val cols = common(t)
                sql.execSQL("INSERT INTO `$t` ($cols) SELECT $cols FROM `arch_$t` WHERE account = ?", arrayOf(account))
                if (t == "self") sql.execSQL("UPDATE self SET email = NULL") // the archive held only a hash
            }
        }
        sql.execSQL("DELETE FROM $STATE WHERE k IN ${marks(stateKeys)}", stateKeys.toTypedArray())
        if (account != null && exists("arch_$STATE")) {
            sql.execSQL("INSERT INTO $STATE (k,v) SELECT k,v FROM `arch_$STATE` WHERE account = ? AND k IN ${marks(stateKeys)}", (listOf(account) + stateKeys).toTypedArray())
        }
        if (account == null || !exists(PREFS)) emptyMap()
        else sql.query("SELECT k,v FROM $PREFS WHERE account = ?", arrayOf(account)).use { c ->
            buildMap { while (c.moveToNext()) put(c.getString(0), c.getString(1)) }
        }
    }

    /** Deletes the archive of [account] (never any key). */
    fun drop(account: String) = db.runInTransaction<Unit> {
        if (exists("arch_pairing")) sql.execSQL("UPDATE arch_pairing SET own_r = zeroblob(32) WHERE account = ?", arrayOf(account))
        for (t in TABLES + STATE) if (exists("arch_$t")) sql.execSQL("DELETE FROM `arch_$t` WHERE account = ?", arrayOf(account))
        if (exists(PREFS)) sql.execSQL("DELETE FROM $PREFS WHERE account = ?", arrayOf(account))
    }
}
