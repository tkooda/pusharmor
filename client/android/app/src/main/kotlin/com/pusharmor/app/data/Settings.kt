package com.pusharmor.app.data

import android.content.Context
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking

/** A corrupt file (flash error, truncated restore) resets to defaults instead of failing every read (I548). */
private val Context.ds by preferencesDataStore("settings", corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() })

/** DataStore settings (section 8 list) plus small app state. */
class Settings(private val context: Context) {
    init { migrateShowContent() }

    object K {
        val SHOW_ALL = booleanPreferencesKey("show_all")
        val TAP_OPENS_LINK = booleanPreferencesKey("tap_opens_link")
        val HISTORY_DAYS = intPreferencesKey("history_days")
        /** Old global "Direct share targets" switch; read once by [Settings.migrateDirectShare], then dropped (I598). */
        val DIRECT_SHARE = booleanPreferencesKey("direct_share")
        /** Device ids left out of the share sheet; absent = every device shows (I598). */
        val SHARE_OFF = stringSetPreferencesKey("share_off")
        val LOCK_SCREEN = booleanPreferencesKey("lock_screen")
        val WATCH = booleanPreferencesKey("watch")
        /** "system" | "light" | "dark"; absent = system. */
        val THEME = stringPreferencesKey("theme")
        /** Old "Always hide content" switch; read once by [Settings.migrateShowContent], then dropped (I600). */
        val HIDE_CONTENT = booleanPreferencesKey("hide_content")
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
        val CH_MESSAGES = stringPreferencesKey("ch_messages")
        val CH_PEERS = stringPreferencesKey("ch_peers")
        val OLD_ID = stringPreferencesKey("old_id")
        val SIGNED_OUT = booleanPreferencesKey("signed_out")
        /** Q368: a Log out the relay server has not yet confirmed; retried until it is settled. */
        val LOGOUT_PENDING = booleanPreferencesKey("logout_pending")
        val BANNER = stringPreferencesKey("banner")
        val LAST_FETCH = longPreferencesKey("last_fetch")
        val LAST_REFRESH = longPreferencesKey("last_refresh")
        val KS_ERROR_BOOT = longPreferencesKey("ks_error_boot")
        val FLAVOR_NOTICE_SHOWN = booleanPreferencesKey("flavor_notice_shown")
        /** Device ids ticked on the last send, comma-separated. */
        val LAST_SEND_TO = stringPreferencesKey("last_send_to")
        val PENDING_EVICT = stringPreferencesKey("pending_evict")
        /** Purpose of an OAuth flow in a Custom Tab ("register" | "login" | "delete-account"). */
        val PENDING_PURPOSE = stringPreferencesKey("pending_purpose")
        /** App version that got HTTP 426; the update screen shows while it is the running version (Q349). */
        val UPDATE_REQUIRED = stringPreferencesKey("update_required")
    }

    val data: Flow<Preferences> get() = context.ds.data

    fun <T> get(key: Preferences.Key<T>): T? = runBlocking { context.ds.data.first()[key] }

    fun <T> set(key: Preferences.Key<T>, value: T?) = runBlocking {
        context.ds.edit { if (value == null) it.remove(key) else it[key] = value }
    }

    /** Last send selection; suspends on DataStore and never blocks the caller, so the Send screen calls it on main (I434). */
    suspend fun lastSendTo(): String? = context.ds.data.first()[K.LAST_SEND_TO]

    suspend fun saveSendTo(ids: List<String>) {
        context.ds.edit { it[K.LAST_SEND_TO] = ids.joinToString(",") }
    }

    fun flag(key: Preferences.Key<Boolean>, default: Boolean): Boolean = get(key) ?: default

    fun <T> flow(key: Preferences.Key<T>): Flow<T?> = context.ds.data.map { it[key] }

    val showAll get() = flag(K.SHOW_ALL, true)
    val tapOpensLink get() = flag(K.TAP_OPENS_LINK, true)
    val historyDays get() = get(K.HISTORY_DAYS) ?: 30
    val shareOff: Set<String> get() = get(K.SHARE_OFF) ?: emptySet()
    val lockScreen get() = flag(K.LOCK_SCREEN, true)
    val watch get() = flag(K.WATCH, true)
    val showContent get() = flag(K.SHOW_CONTENT, true)

    /** The old hide_content value becomes show_content, inverted; the old key is dropped (I600). */
    fun migrateShowContent() = runBlocking {
        context.ds.edit {
            val old = it[K.HIDE_CONTENT] ?: return@edit
            if (it[K.SHOW_CONTENT] == null) it[K.SHOW_CONTENT] = !old
            it.remove(K.HIDE_CONTENT)
        }
    }

    /** Per-device "Show shortcut when sharing" (I598). */
    fun setShareShown(id: String, shown: Boolean) = runBlocking {
        context.ds.edit { val off = it[K.SHARE_OFF] ?: emptySet(); it[K.SHARE_OFF] = if (shown) off - id else off + id }
    }

    /** The old global switch, when off, turns every one of [ids] off; the old key is dropped (I598). */
    fun migrateDirectShare(ids: Collection<String>) = runBlocking {
        context.ds.edit {
            val old = it[K.DIRECT_SHARE] ?: return@edit
            if (!old) it[K.SHARE_OFF] = (it[K.SHARE_OFF] ?: emptySet()) + ids
            it.remove(K.DIRECT_SHARE)
        }
    }

    fun markUpdateRequired(version: String) { if (get(K.UPDATE_REQUIRED) != version) set(K.UPDATE_REQUIRED, version) }

    /** True when this [version] got HTTP 426; a mark left by another version is cleared (Q349). */
    fun updateRequired(version: String): Boolean {
        val seen = get(K.UPDATE_REQUIRED) ?: return false
        if (seen == version) return true
        set(K.UPDATE_REQUIRED, null)
        return false
    }

    /** Clears everything except old_id (kept across the wipe for DELETE /peers/$old-id). */
    fun clearKeepingOldId() = runBlocking {
        context.ds.edit {
            val old = it[K.OLD_ID]
            it.clear()
            if (old != null) it[K.OLD_ID] = old
        }
    }
}
