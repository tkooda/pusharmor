package com.pusharmor.app.ui

import android.app.Application
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.pusharmor.app.PaApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.session.Session
import com.pusharmor.net.ErrorText
import com.pusharmor.net.WorkerClient
import com.pusharmor.protocol.ContentType
import com.pusharmor.protocol.Detect
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.allSet
import com.pusharmor.protocol.engine.ApiResult
import com.pusharmor.protocol.engine.PairStart
import com.pusharmor.protocol.engine.PairingRow
import com.pusharmor.store.HistoryEntity
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.SelfEntity
import com.pusharmor.store.toPeer
import com.pusharmor.store.toRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val g = (app as PaApp).graph

    val start = MutableStateFlow<Session.Start?>(null)
    val message = MutableStateFlow<String?>(null)
    /** The "cannot receive messages" card was closed; not saved, so it shows again on the next app open. */
    val cannotReceiveClosed = MutableStateFlow(false)
    /** Address last sent to (lower case) and the time its resend countdown ends; kept while the screen is left and re-entered. */
    val resend = MutableStateFlow("" to 0L)
    val busy = MutableStateFlow(false)

    /** A database list on a corrupt file waits, instead of crashing the app, until the start state changes (Retry or Reset). */
    private fun <T> Flow<T>.waitOutCorrupt(): Flow<T> = retryWhen { e, _ ->
        if (e !is SQLiteDatabaseCorruptException) return@retryWhen false
        val seen = start.value
        start.first { it != seen && it != Session.Start.DATA_UNAVAILABLE }
        true
    }

    val peerEntities: StateFlow<List<PeerEntity>> = g.dao.peersFlow().waitOutCorrupt().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val peers: StateFlow<List<Peer>> = g.dao.peersFlow().waitOutCorrupt().map { l -> l.map { it.toPeer() } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val pairings: StateFlow<List<PairingRow>> = g.dao.pairingsFlow().waitOutCorrupt().map { l -> l.map { it.toRow() } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val history: StateFlow<List<HistoryEntity>> = g.dao.historyFlow().waitOutCorrupt().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val self: StateFlow<SelfEntity?> = g.dao.selfFlow().waitOutCorrupt().stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val prefs = g.settings.data.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** Peer limit picker state (409 "peer limit"). */
    val limit = MutableStateFlow<WorkerClient.PeerLimit?>(null)
    val highlight = MutableStateFlow<String?>(null)

    companion object {
        /** Line 2 for a tap that failed with an exception: keys, storage, or a plain retry. */
        fun localReason(e: Throwable): String = when (e) {
            is android.database.sqlite.SQLiteFullException -> ErrorText.STORAGE_FULL
            is android.database.SQLException, is java.io.IOException -> ErrorText.SAVE_FAILED
            is java.security.GeneralSecurityException, is java.security.ProviderException -> ErrorText.KEYS_UNUSABLE
            else -> ErrorText.TRY_AGAIN
        }

        /** Line 2 when broken keys could not be deleted: a full disk, else could not save. */
        fun keyDeleteReason(e: Throwable): String =
            if (e is android.database.sqlite.SQLiteFullException || e.message?.contains("ENOSPC") == true || e.message?.contains("No space left") == true) ErrorText.STORAGE_FULL
            else ErrorText.SAVE_FAILED

        /** A signed-in screen whose device the relay server removed or logged out goes back to log in. */
        fun needsReboot(start: Session.Start?, selfPresent: Boolean, signedOut: Boolean): Boolean =
            start == Session.Start.READY && (!selfPresent || signedOut)

        /** Adds [key] to [set]; false when it was already there, so a second tap of the same action does not run. */
        fun claim(set: MutableStateFlow<Set<String>>, key: String): Boolean {
            var won = false
            set.update { won = key !in it; it + key }
            return won
        }
    }

    init {
        viewModelScope.launch {
            combine(g.dao.selfFlow().waitOutCorrupt(), g.settings.data) { s, p -> (s != null) to (p[Settings.K.SIGNED_OUT] == true) }
                .collect { (present, out) -> if (needsReboot(start.value, present, out)) boot() }
        }
    }

    /** Runs a tap handler; an error shows [action] and why, or only goes to the log when [action] is null. */
    fun io(action: String?, block: suspend () -> Unit) = viewModelScope.launch(Dispatchers.IO) {
        busy.value = true
        try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { failed(action, e) } finally { busy.value = false }
    }

    /** An unexpected error in a tap handler shows [action] and the reason instead of crashing the app. */
    private fun failed(action: String?, e: Exception) {
        Log.w("PushArmor", "action failed", e)
        if (action != null) message.value = ErrorText.text(action, localReason(e))
    }

    /** Quoted name of the device [id] for an error line. */
    private fun nameOf(id: String): String = peers.value.firstOrNull { it.id == id }?.let(::label) ?: ""

    /** Keys of taps still running ("send", "logout", "pair:<id>", ...); their button is greyed until the call ends. */
    val running = MutableStateFlow<Set<String>>(emptySet())

    /** [io], unless the same [key] is still running. */
    fun once(key: String, action: String, block: suspend () -> Unit) {
        if (!claim(running, key)) return
        io(action) { try { block() } finally { running.update { it - key } } }
    }

    /** Sign-in purpose, read off the main thread with each start change (Room refuses main-thread reads). */
    val signInPurpose = MutableStateFlow("register")

    /** A plain launch opens Send: set at startup when at least one pairing is complete. */
    @Volatile var launchToSend = false

    /** The purpose reads the database, so a damaged one (the data screen) keeps the last one. */
    private fun setStart(s: Session.Start) { if (s != Session.Start.DATA_UNAVAILABLE) signInPurpose.value = purpose(); start.value = s }

    /** A damaged settings file that was reset says so once, on the main screen. */
    fun resetNotice() { if (g.settings.takeResetNotice()) message.value = UiText.SETTINGS_RESET }

    fun boot() = io(UiText.UNABLE_OPEN_DATA) {
        g.settings.updateRequired(com.pusharmor.app.BuildConfig.VERSION_NAME)
        val s = g.session.startup()
        if (s == Session.Start.READY) launchToSend = launchRoute(g.dao.peers().map { it.toPeer() }, g.dao.self()?.id) == "send"
        setStart(s)
        if (s == Session.Start.READY) resetNotice()
        if (s == Session.Start.READY) g.session.onAppOpen(System.currentTimeMillis())
        if (s == Session.Start.SIGNED_OUT) g.session.retryPendingLogout()
    }

    /** Reset this device on a corrupt database, after the user confirmed; then the start check runs again. */
    fun resetData() = io(UiText.UNABLE_OPEN_DATA) {
        g.session.resetData()
        boot()
    }

    /** Delete broken keys, after the user confirmed: keys that could not be deleted say the login could not start and why. */
    fun deleteBrokenKeys() = io(null) {
        try { g.session.deleteBrokenKeys() } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Log.w("PushArmor", "delete broken keys failed", e)
            message.value = ErrorText.text(UiText.UNABLE_START_LOGIN, keyDeleteReason(e)); return@io
        }
        boot()
    }

    // ---- sign in ----

    fun purpose(): String = g.session.purposeForSignIn()

    /** Prepares keys before an auth call and returns sign_pub (b64url) for the request. */
    suspend fun signPubB64(): String = withContext(Dispatchers.IO) { com.pusharmor.crypto.B64url.encode(g.session.keysForSignIn()) }

    suspend fun emailStart(email: String, turnstile: String, purpose: String): String? = withContext(Dispatchers.IO) {
        try {
            val r = g.client.authEmail(email, signPubB64(), purpose, turnstile)
            val addr = email.trim().lowercase()
            if (r is ApiResult.Ok) { resend.value = addr to System.currentTimeMillis() + UiText.RESEND_MS; r.value }
            else {
                // A 429 starts the countdown from Retry-After so the next try does not spend a security check for nothing.
                if (r is ApiResult.Http && r.status == 429) resend.value = addr to System.currentTimeMillis() + (r.retryAfter ?: 60L) * 1000
                message.value = ErrorText.of(UiText.UNABLE_SEND_CODE, r); null
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { failed(UiText.UNABLE_SEND_CODE, e); null }
    }

    fun emailVerify(requestToken: String, code: String, purpose: String, onDone: () -> Unit) = once("verify", UiText.UNABLE_CHECK_CODE) {
        when (val r = g.client.authEmailVerify(requestToken, code)) {
            is ApiResult.Ok -> ticket(r.value.ticket, r.value.email, purpose, onDone)
            else -> message.value = ErrorText.of(UiText.UNABLE_CHECK_CODE, r)
        }
    }

    fun googleToken(idToken: String, purpose: String, onDone: () -> Unit) = io(UiText.UNABLE_LOGIN_GOOGLE) {
        when (val r = g.client.authGoogleToken(idToken, signPubB64(), purpose)) {
            is ApiResult.Ok -> ticket(r.value.ticket, r.value.email, purpose, onDone)
            else -> message.value = ErrorText.of(UiText.UNABLE_LOGIN_GOOGLE, r)
        }
    }

    /** Key preparation runs off the main thread; a Keystore failure says the login could not start and returns null. */
    private suspend fun <T> withKeys(block: () -> T): T? = withContext(Dispatchers.IO) {
        try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { failed(UiText.UNABLE_START_LOGIN, e); null }
    }

    suspend fun nonce(purpose: String): String? = withKeys { g.session.nonce(purpose) }

    suspend fun oauthUrl(provider: String, purpose: String): String? = withKeys {
        g.settings.set(Settings.K.PENDING_PURPOSE, purpose)
        g.client.oauthUrl(provider, g.session.keysForSignIn(), purpose)
    }

    /**
     * Only a sign-in started on this device is redeemed; a ticket from any other link is dropped. A logged-in
     * device takes only a delete-account ticket, so a link cannot move it to another account.
     */
    fun onAppLinkTicket(ticket: String, email: String?, onDone: () -> Unit) = io(UiText.UNABLE_LOGIN) {
        val purpose = g.settings.get(Settings.K.PENDING_PURPOSE) ?: return@io
        g.settings.set(Settings.K.PENDING_PURPOSE, null)
        if (purpose != "delete-account" && g.dao.self() != null && !g.session.signedOut) return@io
        ticket(ticket, email, purpose, onDone)
    }

    private suspend fun ticket(ticket: String, email: String?, purpose: String, onDone: () -> Unit) {
        if (purpose == "delete-account") {
            val err = g.session.deleteAccount(ticket)
            if (err != null) message.value = err else { setStart(Session.Start.SIGN_IN); withContext(Dispatchers.Main) { onDone() } }
            return
        }
        val evict = limit.value?.let { pendingEvict }
        when (val r = g.session.onTicket(ticket, email, evict)) {
            Session.SignIn.Done -> {
                message.value = null // a failed earlier step must not show on Peers
                g.settings.set(Settings.K.BANNER, null)
                email?.let { e -> g.dao.setSelfEmail(e) }
                limit.value = null
                setStart(Session.Start.READY)
                g.session.onAppOpen(System.currentTimeMillis())
                withContext(Dispatchers.Main) { onDone() }
            }
            is Session.SignIn.Limit -> { limitTicket = r.limit.ticket; message.value = null; limit.value = r.limit }
            Session.SignIn.NeedNewTicket -> message.value = ErrorText.text(if (evict != null) UiText.UNABLE_EVICT else UiText.UNABLE_LOGIN, ErrorText.TRY_AGAIN)
            is Session.SignIn.Error -> {
                if (r.text.endsWith(ErrorText.LOGIN_EXPIRED)) limit.value = limit.value // ticks kept
                message.value = r.text
            }
        }
    }

    private var limitTicket: String? = null
    private var pendingEvict: List<String>? = null

    /** Submit of the peer limit picker: POST /peers with evict, using the 10-min ticket. */
    fun evict(ids: List<String>, onDone: () -> Unit) = once("evict", UiText.UNABLE_EVICT) {
        pendingEvict = ids
        val t = limitTicket ?: return@once
        ticket(t, null, "register", onDone)
    }

    fun cancelLimit() { limit.value = null; pendingEvict = null; message.value = null }

    // ---- peers ----

    /** A Devices refresh (pull or button) is running: the pull indicator shows and the button is greyed. */
    val refreshing = MutableStateFlow(false)
    fun refresh() {
        if (refreshing.value) return
        refreshing.value = true
        io(UiText.UNABLE_REFRESH) { try { g.session.refresh()?.let { message.value = it } } finally { refreshing.value = false } } // offline says so
    }
    fun pair(id: String) = once("pair:$id", UiText.unablePair(nameOf(id))) { refused(id, g.pairing().tapPair(id, System.currentTimeMillis())) }
    /** Says why a Pair or Pair again tap did not start. */
    private fun refused(id: String, r: PairStart) {
        UiText.pairRefused(r, peers.value.firstOrNull { it.id == id }?.let(::label) ?: "")?.let { message.value = it }
    }
    fun reply(id: String) = io(UiText.unablePair(nameOf(id))) { g.pairing().tapReply(id) }
    fun sendAgainPair(id: String) = io(UiText.unablePair(nameOf(id))) { g.pairing().sendAgain(id, System.currentTimeMillis()) }
    fun cancelPairing(id: String) = io(UiText.unableCancelPairing(nameOf(id))) { g.pairing().cancelPairing(id); g.reconcile().run() }
    /** Peer ids with a Pair again call running; their button is greyed so a second tap cannot cancel the first. */
    val pairingAgain = MutableStateFlow<Set<String>>(emptySet())
    fun pairAgain(id: String) {
        if (id in pairingAgain.value) return
        pairingAgain.update { it + id }
        io(UiText.unablePair(nameOf(id))) {
            try {
                val offered = g.store.peer(id)?.offersPairAgain == true
                val r = g.pairing().pairAgain(id, System.currentTimeMillis()) { g.reconcile().run() }
                // Past the offer check the old pairing is already cancelled; say so, the row is now a plain Pair row.
                if (r != PairStart.STARTED && offered) message.value = "The old pairing was cancelled, but a new one could not start. Tap Pair to try again."
                else refused(id, r)
            } finally {
                pairingAgain.update { it - id }
            }
        }
    }
    fun approve(id: String) = once("approve:$id", UiText.unableConfirm(nameOf(id))) {
        val r = g.approve().approve(id)
        if (r !is ApiResult.Ok) message.value = ErrorText.of(UiText.unableConfirm(nameOf(id)), r)
        g.session.updateShortcuts()
    }
    fun deny(id: String) = once("deny:$id", UiText.unableReject(nameOf(id))) {
        val r = g.approve().deny(id); if (r !is ApiResult.Ok) message.value = ErrorText.of(UiText.unableReject(nameOf(id)), r)
    }
    fun remove(id: String) = once("remove:$id", UiText.unableRemove(nameOf(id))) { g.session.removePeer(id)?.let { message.value = it } }
    fun localDelete(id: String) = io(UiText.unableRemove(nameOf(id))) { g.session.localDelete(id) }
    fun setHidden(id: String, hidden: Boolean) = io(UiText.UNABLE_CHANGE_SETTING) { g.session.setHidden(id, hidden) }
    fun setShareShown(id: String, shown: Boolean) = io(UiText.UNABLE_CHANGE_SETTING) { g.settings.setShareShown(id, shown); g.session.updateShortcuts() }
    fun tapGreyed() = io(UiText.UNABLE_REFRESH) { g.session.fetchPeers() }
    fun setPeerSwitch(id: String, lock: Boolean? = null, watch: Boolean? = null, showContent: Boolean? = null) = io(UiText.UNABLE_CHANGE_SETTING) {
        g.dao.updatePeerSwitches(id, lock, watch, showContent)
    }

    /** Peers-screen open: re-enqueue pending pair sends and check timeouts. */
    fun onPeersOpen() = io(UiText.UNABLE_REFRESH) {
        if (g.identity() == null) return@io
        for (r in g.store.pairings()) if (r.pendingMessage != null) com.pusharmor.app.work.Work.pairSend(g.app, r.peerId, replace = true)
        g.session.checkTimeouts(System.currentTimeMillis(), refetch = true)
        for (r in g.store.pairings()) if (r.fingerprint != null) g.notifier.cancelPair(com.pusharmor.crypto.Ids.pairingKey(
            com.pusharmor.crypto.B64url.decode(if (r.role == com.pusharmor.protocol.PairRole.N) g.identity()!!.id else r.peerId),
            com.pusharmor.crypto.B64url.decode(if (r.role == com.pusharmor.protocol.PairRole.N) r.peerId else g.identity()!!.id)))
    }

    // ---- send ----

    fun allPeers(): List<Peer> = allSet(peers.value)

    /** Result of a send: the message to show, and the new History row when it reached a device. */
    class SendResult(val text: String, val historyId: Long? = null) { val ok: Boolean get() = historyId != null }

    /** Set when a send reached a device; the main screen then opens History at that row. */
    val sent = MutableStateFlow<SendResult?>(null)

    /** History row to scroll to and flash once. */
    val flashRow = MutableStateFlow<Long?>(null)

    /** An unexpected error (no keys, a Keystore failure) gives "Unable to send." and why instead of crashing the app. */
    suspend fun send(recipients: List<String>, text: String, asText: Boolean): SendResult = withContext(Dispatchers.IO) {
        if (com.pusharmor.app.BuildConfig.SCREENSHOT_MODE && com.pusharmor.app.ScreenshotMode.on) com.pusharmor.app.ScreenshotMode.sendResult?.let { return@withContext SendResult(it) }
        try {
            val type = if (asText) ContentType.TEXT else Detect.type(text)
            val value = if (type == ContentType.TEXT) text else text.trim()
            val out = g.sender().send(recipients, type, value, System.currentTimeMillis())
            if (out.error != null) return@withContext SendResult(ErrorText.of(UiText.UNABLE_SEND, out.error!!, UiText.pushHost(g.settings.get(Settings.K.UP_ENDPOINT))))
            sendResult(recipients.size, out, recipients.singleOrNull()) { id -> g.store.peer(id)?.let(::label) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Log.w("PushArmor", "send failed", e)
            SendResult(ErrorText.text(UiText.UNABLE_SEND, localReason(e)))
        }
    }

    /**
     * Snackbar text for [out]; a send that reached a device carries its History row and is posted to [sent]. One
     * picked device ([only]) that did not get it says why.
     */
    internal fun sendResult(picked: Int, out: com.pusharmor.protocol.engine.SendFlow.Outcome, only: String? = null, nameOf: (String) -> String?): SendResult {
        val name = out.results.entries.singleOrNull { it.value == "sent" }?.let { nameOf(it.key) }
        val one = if (picked == 1) only ?: out.results.keys.singleOrNull() else null
        val text = one?.let { UiText.sendResultText(out.results[it] ?: "", nameOf(it) ?: "") } ?: UiText.sendToast(picked, out.sent, out.total, name)
        val id = out.historyId?.takeIf { out.sent > 0 } ?: return SendResult(text)
        return SendResult(text, id).also { sent.value = it }
    }

    // ---- settings ----

    fun <T> setPref(key: androidx.datastore.preferences.core.Preferences.Key<T>, v: T?) = io(UiText.UNABLE_CHANGE_SETTING) {
        g.settings.set(key, v)
        if (key == Settings.K.HISTORY_DAYS) g.session.purgeHistory()
    }

    /** Saves the Theme choice and tells the system, so the splash screen and window follow it (no white flash). */
    fun setTheme(t: com.pusharmor.app.ui.theme.ThemePref) {
        setPref(Settings.K.THEME, t.key)
        com.pusharmor.app.ui.theme.ThemePref.applyToSystem(getApplication(), t)
    }

    fun deleteAllHistory() = io(UiText.UNABLE_DELETE_HISTORY) { g.dao.deleteAllHistory() }
    fun deleteHistory(ids: List<Long>) = io(UiText.UNABLE_DELETE_HISTORY) { g.dao.deleteHistory(ids) }
    fun markRead(id: Long) = io(null) { g.dao.markRead(id) }
    fun rename(name: String) = io(UiText.UNABLE_RENAME) { g.session.rename(name)?.let { message.value = it } }
    fun signOut(onDone: () -> Unit) = once("logout", UiText.UNABLE_LOGOUT) {
        g.session.signOut()
        setStart(Session.Start.SIGNED_OUT)
        withContext(Dispatchers.Main) { onDone() }
    }
    fun switchPush(toUp: Boolean) = io(UiText.UNABLE_CHANGE_SETTING) { g.session.pushSwitched(); if (toUp) g.push.switchToUnifiedPush(g) else g.push.switchToGoogle(g) }
    /** Push method choice: [PUSH_GOOGLE] or the package of an installed UnifiedPush app. */
    fun choosePush(choice: String) = io(UiText.UNABLE_CHANGE_SETTING) {
        g.session.pushSwitched()
        if (choice == PUSH_GOOGLE) { g.push.switchToGoogle(g); return@io }
        com.pusharmor.app.push.UnifiedPushSupport.pick(g, choice)
        if (!com.pusharmor.app.push.UnifiedPushSupport.active(g)) g.push.switchToUnifiedPush(g)
    }
    /**
     * Check again on the cannot-receive card: a cause on this device ([local], read on the main thread at the tap) sends no test push; else one test
     * push. "sent" says Working and the card goes; the line for each result is [UiText.checkAgainText].
     */
    fun checkAgain(local: Boolean) = once("check", UiText.CHECK_FAILED) {
        val word = if (local) null else try { g.session.checkPush() } catch (e: Exception) { null }
        UiText.checkAgainText(local, word)?.let { message.value = it }
    }
    fun retryPush() = io(UiText.UNABLE_TURN_ON_NOTIFICATIONS) { com.pusharmor.app.work.Work.patchPush(g.app) }

    /** On each return to the app when signed in: register with a UnifiedPush app installed meanwhile. */
    fun registerIfInstalled() {
        if (start.value != Session.Start.READY) return
        viewModelScope.launch(Dispatchers.IO) {
            try { com.pusharmor.app.push.UnifiedPushSupport.registerIfInstalled(g) } catch (e: CancellationException) { throw e } catch (e: Exception) { Log.w("PushArmor", "push register failed", e) }
        }
    }
}
