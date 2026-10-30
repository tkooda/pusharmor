package com.pusharmor.app.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking

private val Context.ds by preferencesDataStore("settings")

/** DataStore settings (section 8 list) plus small app state. */
class Settings(private val context: Context) {
    object K {
        val SHOW_ALL = booleanPreferencesKey("show_all")
        val TAP_OPENS_LINK = booleanPreferencesKey("tap_opens_link")
        val HISTORY_DAYS = intPreferencesKey("history_days")
        val DIRECT_SHARE = booleanPreferencesKey("direct_share")
        val LOCK_SCREEN = booleanPreferencesKey("lock_screen")
        val WATCH = booleanPreferencesKey("watch")
        /** "system" | "light" | "dark"; absent = system. */
        val THEME = stringPreferencesKey("theme")
        val HIDE_CONTENT = booleanPreferencesKey("hide_content")
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
    val directShare get() = flag(K.DIRECT_SHARE, true)
    val lockScreen get() = flag(K.LOCK_SCREEN, true)
    val watch get() = flag(K.WATCH, true)
    val hideContent get() = flag(K.HIDE_CONTENT, false)

    /** Clears everything except old_id (kept across the wipe for DELETE /peers/$old-id). */
    fun clearKeepingOldId() = runBlocking {
        context.ds.edit {
            val old = it[K.OLD_ID]
            it.clear()
            if (old != null) it[K.OLD_ID] = old
        }
    }
}
