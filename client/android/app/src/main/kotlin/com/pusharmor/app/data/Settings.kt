package com.pusharmor.app.data

import android.content.Context
import android.database.SQLException
import android.os.Looper
import android.util.Log
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.preferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.pusharmor.store.PaDao
import com.pusharmor.store.StateEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.runBlocking
import java.io.IOException

/**
 * A corrupt file (flash error, truncated restore) resets to defaults instead of failing every read, and the reset
 * notice shows once. The reset also marks a sign-in in progress: a file from an older version may have held that
 * mark for keys a sign-in just registered, so startup keeps them.
 */
private val Context.ds by preferencesDataStore("settings", corruptionHandler = ReplaceFileCorruptionHandler {
    preferencesOf(Settings.K.SIGN_IN_KEYS to true, Settings.K.SETTINGS_RESET to true)
})

/**
 * DataStore preferences (section 8 list) plus small app state. The security state in [IN_DB] is kept in the
 * database instead, which shows the data screen on damage: a damaged settings file never resets it.
 */
class Settings(private val context: Context, private val dao: PaDao) {
    init { moveToDb() }

    companion object {
        /** A flag from an already loaded snapshot; [default] until it loads or while unset. */
        fun flagOf(p: Preferences?, key: Preferences.Key<Boolean>, default: Boolean): Boolean = p?.get(key) ?: default

        /** Keys kept in the database's app_state table, by name. */
        val IN_DB: Map<String, Preferences.Key<*>> = listOf(
            K.SIGNED_OUT, K.LOGOUT_PENDING, K.REMOVAL_CHECK, K.OLD_ID, K.SIGN_IN_KEYS, K.PENDING_PURPOSE, K.KEY_ALIAS, K.ACCOUNT,
            K.PUSH_TYPE, K.PUSH_TOKEN, K.UP_ENDPOINT, K.UP_P256DH, K.UP_AUTH, K.UP_REGISTERED_AT, K.UP_VERIFIED, K.PUSH_REFUSED,
        ).associateBy { it.name }
        private val BOOLS = setOf(K.SIGNED_OUT, K.LOGOUT_PENDING, K.SIGN_IN_KEYS, K.UP_VERIFIED, K.PUSH_REFUSED).map { it.name }
        private val LONGS = setOf(K.UP_REGISTERED_AT.name)

        /** The database state that belongs to the active account and moves with it when another account is switched in. */
        val ACCOUNT_STATE = listOf(K.SIGNED_OUT, K.LOGOUT_PENDING, K.REMOVAL_CHECK, K.OLD_ID, K.KEY_ALIAS, K.ACCOUNT).map { it.name }

        /** The settings file keys that belong to the active account; push, theme, channels, and notices stay with the device. */
        val ACCOUNT_PREFS: List<Preferences.Key<*>> = listOf(K.SHOW_ALL, K.TAP_OPENS_LINK, K.HISTORY_DAYS, K.SHARE_OFF, K.LOCK_SCREEN, K.WATCH,
            K.SHOW_CONTENT, K.PUSH_MISSING, K.PATCH_BAD_ID, K.PUSH_ERROR, K.PAIR_ERROR, K.RELAY_FAULT, K.BANNER, K.LAST_FETCH, K.LAST_REFRESH, K.LAST_SEND_TO)

        /** One lock in the process: a deferred move never interleaves with a [set] of the keys it moves. */
        private val dbLock = Any()

        private fun encode(v: Any): String = if (v is Boolean) (if (v) "1" else "0") else v.toString()
        private fun decode(name: String, v: String): Any = when (name) { in BOOLS -> v == "1"; in LONGS -> v.toLong(); else -> v }
    }

    object K {
        val SHOW_ALL = booleanPreferencesKey("show_all")
        val TAP_OPENS_LINK = booleanPreferencesKey("tap_opens_link")
        val HISTORY_DAYS = intPreferencesKey("history_days")
        /** Device ids left out of the share sheet; absent = every device shows. */
        val SHARE_OFF = stringSetPreferencesKey("share_off")
        val LOCK_SCREEN = booleanPreferencesKey("lock_screen")
        val WATCH = booleanPreferencesKey("watch")
        /** "system" | "light" | "dark"; absent = system. */
        val THEME = stringPreferencesKey("theme")
        /** "Show message content in notifications"; absent = on. */
        val SHOW_CONTENT = booleanPreferencesKey("show_content")
        /** "fcm" | "unifiedpush" | absent */
        val PUSH_TYPE = stringPreferencesKey("push_type")
        val PUSH_TOKEN = stringPreferencesKey("push_token")
        val UP_ENDPOINT = stringPreferencesKey("up_endpoint")
        val UP_P256DH = stringPreferencesKey("up_p256dh")
        val UP_AUTH = stringPreferencesKey("up_auth")
        val UP_REGISTERED_AT = longPreferencesKey("up_registered_at")
        val UP_VERIFIED = booleanPreferencesKey("up_verified")
        /** The relay server refused the stored UnifiedPush address; cleared when an address is accepted. */
        val PUSH_REFUSED = booleanPreferencesKey("push_refused")
        /** A relay server reply said push_missing; the next app start sends the push address again. Cleared by an accepted address. */
        val PUSH_MISSING = booleanPreferencesKey("push_missing")
        /** This device id got 401 "bad id" on PATCH push: the relay server does not take it, so it is not sent again. */
        val PATCH_BAD_ID = stringPreferencesKey("patch_bad_id")
        /** Why the push address could not be sent (line 2 of the cannot-receive card); cleared when an address is accepted. */
        val PUSH_ERROR = stringPreferencesKey("push_error")
        /**
         * Push could not be set up on this device: "fcm_token" (no Google token), "up_register" (the UnifiedPush app did not
         * register), or "up_keys" (its address had no usable keys); cleared when a token or address arrives.
         */
        val PUSH_SETUP = stringPreferencesKey("push_setup")
        /** A pairing message that failed in the background: the error text, shown once on the next app screen. */
        val PAIR_ERROR = stringPreferencesKey("pair_error")
        /** The last GET /peers or Check again said the relay server's push to this device failed on its side. */
        val RELAY_FAULT = booleanPreferencesKey("relay_fault")
        val CH_MESSAGES = stringPreferencesKey("ch_messages")
        val CH_PEERS = stringPreferencesKey("ch_peers")
        val OLD_ID = stringPreferencesKey("old_id")
        val SIGNED_OUT = booleanPreferencesKey("signed_out")
        /** a Log out the relay server has not yet confirmed; retried until it is settled. */
        val LOGOUT_PENDING = booleanPreferencesKey("logout_pending")
        val BANNER = stringPreferencesKey("banner")
        /** A removal signal ("removed" | "deleted") not yet confirmed by a second GET /peers; checked again on app open. */
        val REMOVAL_CHECK = stringPreferencesKey("removal_check")
        val LAST_FETCH = longPreferencesKey("last_fetch")
        val LAST_REFRESH = longPreferencesKey("last_refresh")
        val FLAVOR_NOTICE_SHOWN = booleanPreferencesKey("flavor_notice_shown")
        /** Device ids ticked on the last send, comma-separated. */
        val LAST_SEND_TO = stringPreferencesKey("last_send_to")
        /** Purpose of an OAuth flow in a Custom Tab ("register" | "login" | "delete-account"). */
        val PENDING_PURPOSE = stringPreferencesKey("pending_purpose")
        /** Keys were made or loaded for a sign-in that has not registered yet; startup keeps them. */
        val SIGN_IN_KEYS = booleanPreferencesKey("sign_in_keys")
        /** Keystore alias base of the active account's keys; absent = the first account's ("pa"). Kept by the wipe. */
        val KEY_ALIAS = stringPreferencesKey("key_alias")
        /** Account id of the registration a wipe removed, so a switch can still archive the history it kept. */
        val ACCOUNT = stringPreferencesKey("account")
        /** App version that got HTTP 426; the update screen shows while it is the running version. */
        val UPDATE_REQUIRED = stringPreferencesKey("update_required")
        /** The file was damaged and reset to defaults; cleared when the notice shows. */
        val SETTINGS_RESET = booleanPreferencesKey("settings_reset")
    }

    /** Room refuses main-thread calls: a main-thread call waits on an IO thread, as the DataStore reads here do. */
    private fun <T> db(block: () -> T): T = if (Looper.myLooper() == Looper.getMainLooper()) runBlocking(Dispatchers.IO) { block() } else block()

    /**
     * A database that never read reads as no state here (the data screen shows); one that read keeps its last
     * state through a later error. Either is checked again until it opens.
     */
    private val dbState: Flow<List<StateEntity>> = flow {
        var read = false
        emitAll(dao.stateFlow().onEach { read = true }.retryWhen { e, _ ->
            if (e !is SQLException) return@retryWhen false
            if (!read) emit(emptyList())
            delay(2000); true
        })
    }

    /** The preferences with the database state laid over them, so screens read both from one snapshot. */
    val data: Flow<Preferences> get() = combine(context.ds.data, dbState) { p, rows ->
        p.toMutablePreferences().also { m -> for (r in rows) put(m, r) }
    }

    @Suppress("UNCHECKED_CAST")
    private fun put(m: MutablePreferences, r: StateEntity) {
        val key = IN_DB[r.k] as? Preferences.Key<Any> ?: return
        m[key] = decode(r.k, r.v)
    }

    /** A key in [IN_DB] with no database row reads the copy a deferred move left in the file, as [data] does. */
    @Suppress("UNCHECKED_CAST")
    fun <T> get(key: Preferences.Key<T>): T? =
        if (key.name in IN_DB) db { dao.state(key.name) }?.let { decode(key.name, it) as T } ?: runBlocking { context.ds.data.first()[key] }
        else runBlocking { context.ds.data.first()[key] }

    fun <T> set(key: Preferences.Key<T>, value: T?) {
        if (key.name in IN_DB) synchronized(dbLock) {
            db { if (value == null) dao.deleteState(key.name) else dao.putState(StateEntity(key.name, encode(value))) }
            // A copy an older version left in the file (its move deferred) must not come back on the next move.
            runBlocking { if (context.ds.data.first().contains(key)) context.ds.edit { it.remove(key) } }
        }
        else runBlocking { context.ds.edit { if (value == null) it.remove(key) else it[key] = value } }
    }

    /**
     * Security state an older version kept in the settings file goes to the database; a value already there wins.
     * The file keys are dropped only after the database write; a damaged database keeps them for the next try
     * (each startup check runs it again).
     */
    fun moveToDb() = synchronized(dbLock) { moveLocked() }

    private fun moveLocked() {
        val p = runBlocking { context.ds.data.first() }
        val old = IN_DB.values.filter { p.contains(it) }
        if (old.isEmpty()) return
        try {
            db { for (k in old) if (dao.state(k.name) == null) dao.putState(StateEntity(k.name, encode(p[k]!!))) }
        } catch (e: SQLException) {
            Log.w("PushArmor", "settings move deferred", e); return
        }
        // A file that cannot be written keeps the copies; the database values win over them, and the next start tries again.
        try { runBlocking { context.ds.edit { e -> old.forEach { e.remove(it) } } } } catch (e: IOException) { Log.w("PushArmor", "settings copies kept", e) }
    }

    /** True once after the settings file was damaged and reset; the mark is then cleared. */
    fun takeResetNotice(): Boolean = runBlocking {
        var had = false
        context.ds.edit { had = it[K.SETTINGS_RESET] == true; it.remove(K.SETTINGS_RESET) }
        had
    }

    /** Last send selection; suspends on DataStore and never blocks the caller, so the Send screen calls it on main. */
    suspend fun lastSendTo(): String? = context.ds.data.first()[K.LAST_SEND_TO]

    suspend fun saveSendTo(ids: List<String>) {
        context.ds.edit { it[K.LAST_SEND_TO] = ids.joinToString(",") }
    }

    fun flag(key: Preferences.Key<Boolean>, default: Boolean): Boolean = get(key) ?: default

    fun <T> flow(key: Preferences.Key<T>): Flow<T?> = data.map { it[key] }

    val showAll get() = flag(K.SHOW_ALL, true)
    val tapOpensLink get() = flag(K.TAP_OPENS_LINK, true)
    val historyDays get() = get(K.HISTORY_DAYS) ?: 30
    val shareOff: Set<String> get() = get(K.SHARE_OFF) ?: emptySet()
    val lockScreen get() = flag(K.LOCK_SCREEN, true)
    val watch get() = flag(K.WATCH, true)
    val showContent get() = flag(K.SHOW_CONTENT, true)

    /** Per-device "Show shortcut when sharing". */
    fun setShareShown(id: String, shown: Boolean) = runBlocking {
        context.ds.edit { val off = it[K.SHARE_OFF] ?: emptySet(); it[K.SHARE_OFF] = if (shown) off - id else off + id }
    }

    fun markUpdateRequired(version: String) { if (get(K.UPDATE_REQUIRED) != version) set(K.UPDATE_REQUIRED, version) }

    /** True when this [version] got HTTP 426; a mark left by another version is cleared. */
    fun updateRequired(version: String): Boolean {
        val seen = get(K.UPDATE_REQUIRED) ?: return false
        if (seen == version) return true
        set(K.UPDATE_REQUIRED, null)
        return false
    }

    /**
     * Clears everything except old_id (kept across the wipe for DELETE /peers/$old-id; a copy not yet moved stays in the file)
     * and the key alias base (an archived account's keys are never reused).
     */
    fun clearKeepingOldId() {
        db { dao.clearStateExcept(listOf(K.OLD_ID.name, K.KEY_ALIAS.name)) }
        runBlocking {
            context.ds.edit {
                val old = it[K.OLD_ID]
                it.clear()
                if (old != null) it[K.OLD_ID] = old
            }
        }
    }

    /** The active account's settings file values, each as a type letter and the value. */
    fun accountPrefs(): Map<String, String> {
        val p = runBlocking { context.ds.data.first() }
        return ACCOUNT_PREFS.mapNotNull { k ->
            when (val v = p[k]) {
                null -> null
                is Boolean -> k.name to "b" + (if (v) "1" else "0")
                is Int -> k.name to "i$v"
                is Long -> k.name to "l$v"
                is String -> k.name to "s$v"
                is Set<*> -> k.name to "S" + v.joinToString("\n")
                else -> null
            }
        }.toMap()
    }

    /** Replaces the active account's settings file values with [m] (from [accountPrefs]) in one write. */
    @Suppress("UNCHECKED_CAST")
    fun putAccountPrefs(m: Map<String, String>) = runBlocking {
        context.ds.edit { e ->
            for (k in ACCOUNT_PREFS) e.remove(k)
            for (k in ACCOUNT_PREFS) {
                val v = m[k.name] ?: continue
                val x = v.drop(1)
                when (v.first()) {
                    'b' -> e[k as Preferences.Key<Boolean>] = x == "1"
                    'i' -> x.toIntOrNull()?.let { e[k as Preferences.Key<Int>] = it }
                    'l' -> x.toLongOrNull()?.let { e[k as Preferences.Key<Long>] = it }
                    's' -> e[k as Preferences.Key<String>] = x
                    'S' -> e[k as Preferences.Key<Set<String>>] = if (x.isEmpty()) emptySet() else x.split("\n").toSet()
                }
            }
        }
        Unit
    }
}
