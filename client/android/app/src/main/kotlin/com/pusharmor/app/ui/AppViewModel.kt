package com.pusharmor.app.ui

import android.app.Application
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
import com.pusharmor.protocol.engine.PairingRow
import com.pusharmor.store.HistoryEntity
import com.pusharmor.store.PeerEntity
import com.pusharmor.store.SelfEntity
import com.pusharmor.store.toPeer
import com.pusharmor.store.toRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val g = (app as PaApp).graph

    val start = MutableStateFlow<Session.Start?>(null)
    val message = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)

    val peerEntities: StateFlow<List<PeerEntity>> = g.dao.peersFlow().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val peers: StateFlow<List<Peer>> = g.dao.peersFlow().map { l -> l.map { it.toPeer() } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val pairings: StateFlow<List<PairingRow>> = g.dao.pairingsFlow().map { l -> l.map { it.toRow() } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val history: StateFlow<List<HistoryEntity>> = g.dao.historyFlow().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val self: StateFlow<SelfEntity?> = g.dao.selfFlow().stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val prefs = g.settings.data.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** Peer limit picker state (409 "peer limit"). */
    val limit = MutableStateFlow<WorkerClient.PeerLimit?>(null)
    val highlight = MutableStateFlow<String?>(null)

    fun io(block: suspend () -> Unit) = viewModelScope.launch(Dispatchers.IO) {
        busy.value = true
        try { block() } finally { busy.value = false }
    }

    /** Sign-in purpose, read off the main thread with each start change (Room refuses main-thread reads). */
    val signInPurpose = MutableStateFlow("register")

    private fun setStart(s: Session.Start) { signInPurpose.value = purpose(); start.value = s }

    fun boot(fromMain: Boolean = true) = io {
        val s = g.session.startup(fromMain)
        setStart(s)
        if (s == Session.Start.READY) g.session.onAppOpen(System.currentTimeMillis())
    }

    // ---- sign in ----

    fun purpose(): String = g.session.purposeForSignIn()

    /** Prepares keys before an auth call and returns sign_pub (b64url) for the request. */
    suspend fun signPubB64(): String = withContext(Dispatchers.IO) { com.pusharmor.crypto.B64url.encode(g.session.keysForSignIn()) }

    suspend fun emailStart(email: String, turnstile: String, purpose: String): String? = withContext(Dispatchers.IO) {
        val r = g.client.authEmail(email, signPubB64(), purpose, turnstile)
        if (r is ApiResult.Ok) r.value else { message.value = ErrorText.of(r); null }
    }

    fun emailVerify(requestToken: String, code: String, purpose: String, onDone: () -> Unit) = io {
        when (val r = g.client.authEmailVerify(requestToken, code)) {
            is ApiResult.Ok -> ticket(r.value.ticket, r.value.email, purpose, onDone)
            else -> message.value = ErrorText.of(r)
        }
    }

    fun googleToken(idToken: String, purpose: String, onDone: () -> Unit) = io {
        when (val r = g.client.authGoogleToken(idToken, signPubB64(), purpose)) {
            is ApiResult.Ok -> ticket(r.value.ticket, r.value.email, purpose, onDone)
            else -> message.value = ErrorText.of(r)
        }
    }

    fun oauthUrl(provider: String, purpose: String): String {
        g.settings.set(Settings.K.PENDING_PURPOSE, purpose)
        return g.client.oauthUrl(provider, g.session.keysForSignIn(), purpose)
    }

    fun onAppLinkTicket(ticket: String, email: String?, onDone: () -> Unit) = io {
        val purpose = g.settings.get(Settings.K.PENDING_PURPOSE) ?: purpose()
        g.settings.set(Settings.K.PENDING_PURPOSE, null)
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
                message.value = null // a failed earlier step must not show on Peers (I425)
                email?.let { e -> g.dao.self()?.let { g.dao.putSelf(it.copy(email = e)) } }
                limit.value = null
                setStart(Session.Start.READY)
                g.session.onAppOpen(System.currentTimeMillis())
                withContext(Dispatchers.Main) { onDone() }
            }
            is Session.SignIn.Limit -> { limitTicket = r.limit.ticket; message.value = null; limit.value = r.limit }
            Session.SignIn.NeedNewTicket -> message.value = "Please sign in again"
            is Session.SignIn.Error -> {
                if (r.text == "Sign-in expired, sign in again") limit.value = limit.value // ticks kept
                message.value = r.text
            }
        }
    }

    private var limitTicket: String? = null
    private var pendingEvict: List<String>? = null

    /** Submit of the peer limit picker: POST /peers with evict, using the 10-min ticket. */
    fun evict(ids: List<String>, onDone: () -> Unit) = io {
        pendingEvict = ids
        val t = limitTicket ?: return@io
        ticket(t, null, "register", onDone)
    }

    fun cancelLimit() { limit.value = null; pendingEvict = null; message.value = null }

    // ---- peers ----

    fun refresh() = io { if (!g.session.refresh()) message.value = null }
    fun pair(id: String) = io { if (!g.pairing().tapPair(id, System.currentTimeMillis())) message.value = "Cannot pair with this device now" }
    fun reply(id: String) = io { g.pairing().tapReply(id) }
    fun sendAgainPair(id: String) = io { g.pairing().sendAgain(id, System.currentTimeMillis()) }
    fun cancelPairing(id: String) = io { g.pairing().cancelPairing(id); g.reconcile().run() }
    fun pairAgain(id: String) = io {
        if (!g.pairing().pairAgain(id, System.currentTimeMillis()) { g.reconcile().run() }) message.value = "Cannot pair with this device now"
    }
    fun approve(id: String) = io {
        val r = g.approve().approve(id)
        if (r !is ApiResult.Ok) message.value = ErrorText.of(r)
        g.session.updateShortcuts()
    }
    fun deny(id: String) = io { val r = g.approve().deny(id); if (r !is ApiResult.Ok) message.value = ErrorText.of(r) }
    fun remove(id: String) = io { g.session.removePeer(id)?.let { message.value = it } }
    fun localDelete(id: String) = io { g.session.localDelete(id) }
    fun setHidden(id: String, hidden: Boolean) = io { g.session.setHidden(id, hidden) }
    fun tapGreyed() = io { g.session.fetchPeers() }
    fun setPeerSwitch(id: String, lock: Boolean? = null, watch: Boolean? = null, hide: Boolean? = null) = io {
        g.dao.peer(id)?.let { p -> g.dao.putPeer(p.copy(lockScreen = lock ?: p.lockScreen, watch = watch ?: p.watch, hideContent = hide ?: p.hideContent)) }
    }

    /** Peers-screen open: re-enqueue pending pair sends and check timeouts. */
    fun onPeersOpen() = io {
        if (g.identity() == null) return@io
        for (r in g.store.pairings()) if (r.pendingMessage != null) com.pusharmor.app.work.Work.pairSend(g.app, r.peerId, replace = true)
        g.session.checkTimeouts(System.currentTimeMillis(), refetch = true)
        for (r in g.store.pairings()) if (r.fingerprint != null) g.notifier.cancelPair(com.pusharmor.crypto.Ids.pairingKey(
            com.pusharmor.crypto.B64url.decode(if (r.role == com.pusharmor.protocol.PairRole.N) g.identity()!!.id else r.peerId),
            com.pusharmor.crypto.B64url.decode(if (r.role == com.pusharmor.protocol.PairRole.N) r.peerId else g.identity()!!.id)))
    }

    // ---- send ----

    fun allPeers(): List<Peer> = allSet(peers.value)

    /** Returns the toast text. */
    suspend fun send(recipients: List<String>, text: String, asText: Boolean): String = withContext(Dispatchers.IO) {
        val type = if (asText) ContentType.TEXT else Detect.type(text)
        val value = if (type == ContentType.TEXT) text else text.trim()
        val out = g.sender().send(recipients, type, value, System.currentTimeMillis())
        if (out.error != null) return@withContext ErrorText.of(out.error!!)
        val sent = out.sent
        when {
            recipients.size == 1 && sent == 1 -> "Sent"
            sent == out.total && sent == recipients.size -> "Delivered to $sent devices"
            else -> "Sent to $sent of ${out.total} devices"
        }
    }

    // ---- settings ----

    fun <T> setPref(key: androidx.datastore.preferences.core.Preferences.Key<T>, v: T?) = io {
        g.settings.set(key, v)
        if (key == Settings.K.DIRECT_SHARE) g.session.updateShortcuts()
        if (key == Settings.K.HISTORY_DAYS) g.session.purgeHistory()
    }

    /** Saves the Theme choice and tells the system, so the splash screen and window follow it (no white flash). */
    fun setTheme(t: com.pusharmor.app.ui.theme.ThemePref) {
        setPref(Settings.K.THEME, t.key)
        com.pusharmor.app.ui.theme.ThemePref.applyToSystem(getApplication(), t)
    }

    fun deleteAllHistory() = io { g.dao.deleteAllHistory() }
    fun markRead(id: Long) = io { g.dao.markRead(id) }
    fun rename(name: String) = io { g.session.rename(name)?.let { message.value = it } }
    fun signOut(onDone: () -> Unit) = io {
        val err = g.session.signOut()
        if (err != null) message.value = err else { setStart(Session.Start.SIGNED_OUT); withContext(Dispatchers.Main) { onDone() } }
    }
    fun switchPush(toUp: Boolean) = io { if (toUp) g.push.switchToUnifiedPush(g) else g.push.switchToGoogle(g) }
    fun retryPush() = io { com.pusharmor.app.work.Work.patchPush(g.app) }
}
