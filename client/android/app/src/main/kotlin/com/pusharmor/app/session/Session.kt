package com.pusharmor.app.session

import android.content.Intent
import android.os.SystemClock
import android.provider.Settings as SysSettings
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.work.WorkManager
import com.pusharmor.app.BuildConfig
import com.pusharmor.app.Graph
import com.pusharmor.app.R
import com.pusharmor.app.ScreenshotMode
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.push.UnifiedPushSupport
import com.pusharmor.app.ui.ShareActivity
import com.pusharmor.app.work.Work
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.signInKeys
import com.pusharmor.net.ErrorText
import com.pusharmor.net.WorkerClient
import com.pusharmor.protocol.MessageBody
import com.pusharmor.protocol.NameEntry
import com.pusharmor.protocol.allSet
import com.pusharmor.protocol.engine.ApiResult
import com.pusharmor.protocol.engine.ClockSkew
import com.pusharmor.protocol.engine.Outbox
import com.pusharmor.store.SelfEntity

/** Sign-in, registration, sign out, removal, refresh and the startup invariant (sections 5, 8, 9). */
class Session(private val g: Graph) {
    enum class Start { SIGN_IN, SIGNED_OUT, READY, KEYS_UNAVAILABLE }

    companion object {
        const val REMOVED = "This device was removed. Log in again"
        const val LOST_KEYS = "This device lost its keys. Log in again"
        const val DELETED = "Account deleted on another device"
        const val KEYS_UNAVAILABLE = "Keys unavailable. Restart this device."
        const val NO_GOOGLE_PUSH = "This build has no Google push. Install a UnifiedPush app or reinstall from Play"
        const val REFRESH_GREY_MS = 60_000L
    }

    private val s get() = g.settings
    private val dao get() = g.dao

    /** Startup invariant, before any network call (section 9). */
    fun startup(fromMainActivity: Boolean): Start {
        val present: Boolean
        val any: Boolean
        try {
            present = KeystoreKeyOps.present()
            any = KeystoreKeyOps.anyPresent()
        } catch (e: Exception) {
            // The same Keystore error counts only across two distinct boots, from MainActivity starts.
            if (!fromMainActivity) return Start.KEYS_UNAVAILABLE
            val anchor = (System.currentTimeMillis() - SystemClock.elapsedRealtime()) / 60_000
            val prev = s.get(Settings.K.KS_ERROR_BOOT)
            if (prev != null && kotlin.math.abs(prev - anchor) > 2) { selfRemoved(deleted = false, lostKeys = true); return Start.SIGN_IN }
            s.set(Settings.K.KS_ERROR_BOOT, anchor)
            return Start.KEYS_UNAVAILABLE
        }
        s.set(Settings.K.KS_ERROR_BOOT, null)
        val self = dao.self()
        if (self == null) {
            if (any) KeystoreKeyOps.deleteBoth() // restored profile with keys but no counters
            return Start.SIGN_IN
        }
        if (!present) { selfRemoved(deleted = false, lostKeys = true); return Start.SIGN_IN }
        g.keysOrNull = KeystoreKeyOps.load()
        return if (s.flag(Settings.K.SIGNED_OUT, false)) Start.SIGNED_OUT else Start.READY
    }

    /** App start / open work when signed in (no GET /peers on app open). */
    fun onAppOpen(now: Long) {
        if (BuildConfig.SCREENSHOT_MODE && ScreenshotMode.on) return
        if (g.identity() == null || s.flag(Settings.K.SIGNED_OUT, false)) return
        flavorRule()
        g.push.start(g)
        g.push.distributorCheck(g)
        pushReconcile()
        g.reconcile().run()
        refetchWaiting()
        checkTimeouts(now, refetch = false)
        for (r in g.store.pairings()) if (r.pendingMessage != null) Work.pairSend(g.app, r.peerId, replace = true)
        purgeHistory()
    }

    /** foss cannot serve a stored fcm push: clear it, tell once, run the distributor flow. */
    private fun flavorRule() {
        val type = s.get(Settings.K.PUSH_TYPE) ?: return
        if (g.push.canServe(type)) return
        s.set(Settings.K.PUSH_TYPE, null); s.set(Settings.K.PUSH_TOKEN, null)
        if (!s.flag(Settings.K.FLAVOR_NOTICE_SHOWN, false)) { s.set(Settings.K.FLAVOR_NOTICE_SHOWN, true); g.notifier.peersNotice(NO_GOOGLE_PUSH, 6) }
        if (UnifiedPushSupport.distributors(g.app).isEmpty()) Work.patchPush(g.app) // PATCH push null: peers see unreachable
        UnifiedPushSupport.register(g)
    }

    // ---- sign-in -------------------------------------------------------------------------

    val signedOut: Boolean get() = s.flag(Settings.K.SIGNED_OUT, false) && dao.self() != null

    fun purposeForSignIn(): String = if (signedOut) "login" else "register"

    /**
     * Keys are made BEFORE sign-in (sign_pub goes into the auth call); a signed-out device keeps its keys.
     * The same keys serve every call of one sign-in attempt, so the nonce and sign_pub always match.
     */
    fun keysForSignIn(): ByteArray = signInKeys(g.keysOrNull, { KeystoreKeyOps.load() }, { KeystoreKeyOps.createFresh() }) { g.keysOrNull = it }.signPub

    fun nonce(purpose: String) = Ids.oauthNonce(purpose, keysForSignIn())

    sealed class SignIn {
        object Done : SignIn()
        class Limit(val limit: WorkerClient.PeerLimit) : SignIn()
        object NeedNewTicket : SignIn()
        class Error(val text: String) : SignIn()
    }

    /** A ticket arrived (email code, Google token, or the App Link). */
    fun onTicket(ticket: String, email: String?, evict: List<String>? = null): SignIn {
        if (email != null) s.set(Settings.K.BANNER, null)
        return if (signedOut) login(ticket) else register(ticket, email, evict)
    }

    private fun register(ticket: String, email: String?, evict: List<String>?): SignIn {
        val k = g.keysOrNull ?: return SignIn.Error("No keys")
        val sp = B64url.encode(k.signPub); val ep = B64url.encode(k.encPub)
        // POST /peers is signed by the new key with no PA-ID: the client signs with keysOrNull.
        return when (val r = g.client.register(ticket, sp, ep, evict)) {
            is WorkerClient.RegisterResult.Ok -> {
                val id = r.registered.id
                val raw = Ids.decodeId(id)
                if (raw == null || !raw.copyOfRange(9, 21).contentEquals(Ids.keyhash(k.signPub, k.encPub))) return SignIn.Error("Bad reply")
                dao.putSelf(SelfEntity(id = id, accountPrefix = raw.copyOf(9), email = email, name = defaultName()))
                g.sync().merge(r.registered.peers)
                s.set(Settings.K.SIGNED_OUT, false)
                deleteOldId()
                g.push.start(g)
                updateShortcuts()
                SignIn.Done
            }
            is WorkerClient.RegisterResult.Limit -> SignIn.Limit(r.limit)
            is WorkerClient.RegisterResult.Error -> {
                val e = r.result
                if (e is ApiResult.Http && e.status == 409 && e.error == "id collision") {
                    g.keysOrNull = KeystoreKeyOps.createFresh(); SignIn.NeedNewTicket
                } else SignIn.Error(ErrorText.of(e))
            }
        }
    }

    private fun login(ticket: String): SignIn {
        val r = g.logoutFlow().login(ticket)
        if (r !is ApiResult.Ok) return SignIn.Error(ErrorText.of(r))
        s.set(Settings.K.SIGNED_OUT, false)
        // after a successful login: the app-start push reconcile at once, and one GET /peers
        g.push.start(g)
        pushReconcile()
        fetchPeers(force = true)
        refetchWaiting()
        return SignIn.Done
    }

    /** After a keys-lost re-registration: DELETE /peers/$old-id with empty m (400 counts as done). */
    private fun deleteOldId() {
        val old = s.get(Settings.K.OLD_ID) ?: return
        val r = g.client.deletePeer(old, emptyMap())
        if (r is ApiResult.Ok || (r is ApiResult.Http && r.status == 400)) s.set(Settings.K.OLD_ID, null)
    }

    private fun defaultName(): String {
        val n = SysSettings.Global.getString(g.app.contentResolver, SysSettings.Global.DEVICE_NAME).orEmpty()
            .filter { it.code in 0x20..0x7e }.trim().take(32)
        return n.ifEmpty { "Android" }
    }

    // ---- sign out / delete ----------------------------------------------------------------

    fun signOut(): String? {
        val r = g.logoutFlow().logout()
        if (r !is ApiResult.Ok) return ErrorText.of(r)
        s.set(Settings.K.SIGNED_OUT, true)
        return null
    }

    /** DELETE /account with a delete-account ticket; then wipe everything including the keys. */
    fun deleteAccount(ticket: String): String? {
        val me = g.identity() ?: return "No keys"
        val outbox = Outbox(g.store, me)
        val r = ClockSkew.run({
            g.store.allowSet().mapNotNull { g.store.peer(it)?.takeIf { p -> p.pinned } }.associate { it.id to outbox.simple(it, MessageBody.Delete).message }
        }) { g.client.deleteAccount(ticket, B64url.encode(me.keys.signPub), it) }
        if (r !is ApiResult.Ok) return ErrorText.of(r)
        wipe(keepOldId = false)
        return null
    }

    /** Self removed (remove about me, delete, 401 "unknown peer") or keys lost. */
    fun selfRemoved(deleted: Boolean, lostKeys: Boolean) {
        val oldId = dao.self()?.id
        wipe(keepOldId = lostKeys)
        if (lostKeys && oldId != null) s.set(Settings.K.OLD_ID, oldId)
        s.set(Settings.K.BANNER, if (deleted) DELETED else if (lostKeys) LOST_KEYS else REMOVED)
    }

    /** The one wipe routine, in order (section 9); history is kept (I267). */
    private fun wipe(keepOldId: Boolean) {
        g.notifier.cancelAll()
        g.notifier.deleteAllPeerChannels()
        ShortcutManagerCompat.removeAllDynamicShortcuts(g.app)
        WorkManager.getInstance(g.app).cancelAllWork()
        if (keepOldId) s.clearKeepingOldId() else s.clearKeepingOldId().also { s.set(Settings.K.OLD_ID, null) }
        g.notifier.ensureChannels()
        try { g.push.stop(g) } catch (e: Exception) { }
        try { KeystoreKeyOps.deleteBoth() } catch (e: Exception) { }
        g.keysOrNull = null
        g.store.wipeRegistration()
        Work.scheduleDaily(g.app)
    }

    // ---- peers ----------------------------------------------------------------------------

    /** GET /peers (coalesced unless [force]); merge, push_missing, reconcile. */
    /**
     * [inPush]: from the 10 s push handler (I299): one short attempt, the reconcile and any
     * retry go to WorkManager.
     */
    fun fetchPeers(force: Boolean = false, inPush: Boolean = false): Boolean {
        if (g.identity() == null) return true
        val now = System.currentTimeMillis()
        val last = s.get(Settings.K.LAST_FETCH) ?: 0
        if (!force && now - last < Work.FETCH_WINDOW_MS) { Work.fetchPeers(g.app, s); return true }
        s.set(Settings.K.LAST_FETCH, now)
        val ok = when (val r = if (inPush) g.client.peersOnce() else g.client.peers()) {
            is ApiResult.Ok -> {
                g.sync().merge(r.value)
                if (r.pushMissing || (r.value.myPushSha256 != currentPushHash() && currentPushHash() != null)) Work.patchPush(g.app)
                if (inPush) Work.reconcile(g.app) else g.reconcile().run()
                updateShortcuts()
                true
            }
            is ApiResult.Http -> {
                if (r.isUnknownPeer) selfRemoved(deleted = false, lostKeys = false)
                if (r.isLoggedOut) s.set(Settings.K.SIGNED_OUT, true)
                r.status != 503 && r.status != 429
            }
            ApiResult.Network -> false
        }
        if (!ok && inPush) Work.fetchPeers(g.app, s)
        return ok
    }

    /** Refresh button (greyed 60 s): GET /peers, push hash check, reconcile, approve re-fetch. */
    fun refresh(): Boolean {
        val now = System.currentTimeMillis()
        if (now - (s.get(Settings.K.LAST_REFRESH) ?: 0) < REFRESH_GREY_MS) return false
        s.set(Settings.K.LAST_REFRESH, now)
        fetchPeers(force = true)
        refetchWaiting()
        return true
    }

    /** "Waiting for $X": re-send the same approve on app open and Refresh (I265). */
    fun refetchWaiting() {
        if (g.identity() == null) return
        val flow = g.approve()
        for (p in g.store.peers()) if (p.waiting && p.storedApprove != null) flow.refetch(p.id)
    }

    fun checkTimeouts(now: Long, @Suppress("UNUSED_PARAMETER") refetch: Boolean) {
        if (g.identity() == null) return
        val engine = g.pairing()
        val flow = g.approve()
        for (r in g.store.pairings()) {
            engine.checkTimeout(r.peerId, now) { id -> flow.refetch(id) }
        }
    }

    /** Remove (account-wide): DELETE /peers/$X with a remove message for every pinned allow id. */
    fun removePeer(peerId: String): String? {
        val me = g.identity() ?: return "No keys"
        val outbox = Outbox(g.store, me)
        val r = g.reconcile().withMissingRetry {
            ClockSkew.run({
                g.store.allowSet().mapNotNull { g.store.peer(it)?.takeIf { p -> p.pinned } }.associate { it.id to outbox.simple(it, MessageBody.Remove(peerId)).message }
            }) { g.client.deletePeer(peerId, it) }
        }
        if (r !is ApiResult.Ok) return ErrorText.of(r)
        g.notifier.deletePeerChannel(peerId)
        g.store.tx {
            g.store.pairing(peerId)?.let { g.store.deletePairing(peerId) }
            g.store.deleteWindow(peerId)
            g.store.peer(peerId)?.let { g.store.putPeer(it.copy(signPub = null, encPub = null, pairingId = null, removed = true, approved = false, approveVerified = false)) }
        }
        updateShortcuts()
        return null
    }

    /** Local Delete of a missing row: drop the pin and shortcut, keep history, no Worker call. */
    fun localDelete(peerId: String) {
        g.notifier.deletePeerChannel(peerId)
        g.store.tx { g.store.deleteWindow(peerId); g.store.deletePeer(peerId) }
        ShortcutManagerCompat.removeDynamicShortcuts(g.app, listOf(peerId))
        Work.reconcile(g.app)
    }

    fun setHidden(peerId: String, hidden: Boolean) {
        g.store.peer(peerId)?.let { g.store.putPeer(it.copy(hidden = hidden)) }
        updateShortcuts()
    }

    /** Rename this device: PATCH name entries + rename messages for every pinned allow id. */
    fun rename(newName: String): String? {
        if (!NameEntry.isValidName(newName)) return "Use 1 to 32 plain ASCII characters."
        val me = g.identity() ?: return "No keys"
        val self = dao.self() ?: return "No keys"
        dao.putSelf(self.copy(name = newName))
        val outbox = Outbox(g.store, me)
        val r = g.reconcile().withMissingRetry {
            ClockSkew.run({
                val built = g.store.allowSet().mapNotNull { g.store.peer(it)?.takeIf { p -> p.pinned } }.associate { it.id to outbox.rename(it) }
                built.mapValues { it.value.nameEntry!! } to built.mapValues { it.value.message }
            }) { (names, m) -> g.client.rename(names, m) }
        }
        return if (r is ApiResult.Ok) null else ErrorText.of(r)
    }

    // ---- push -----------------------------------------------------------------------------

    private fun currentPush(): Pair<String, List<String>>? = when (s.get(Settings.K.PUSH_TYPE)) {
        "fcm" -> s.get(Settings.K.PUSH_TOKEN)?.let { WorkerClient.obj("type" to WorkerClient.str("fcm"), "token" to WorkerClient.str(it)) to listOf("fcm", it) }
        "unifiedpush" -> UnifiedPushSupport.pushJson(g)
        else -> null
    }

    private fun currentPushHash(): String? = currentPush()?.let { Ids.pushSha256(it.second) }

    /** Compare the current token with the last PATCHed one; PATCH if changed. */
    fun pushReconcile() {
        if (currentPushHash() != dao.self()?.pushHash) Work.patchPush(g.app)
    }

    /** true = done, false = retry later, null = permanent (401 "logged out"). */
    fun patchPushNow(): Boolean? {
        val p = currentPush()
        val r = g.client.patchPush(p?.first ?: "null")
        return when {
            r is ApiResult.Ok -> { dao.self()?.let { dao.putSelf(it.copy(pushHash = p?.let { x -> Ids.pushSha256(x.second) })) }; true }
            r.isLoggedOut -> null
            r.isUnknownPeer -> { selfRemoved(deleted = false, lostKeys = false); null }
            r is ApiResult.Http && r.status in 400..499 && r.status != 429 -> null
            else -> false
        }
    }

    /** UnifiedPush probe: confirm at once with no user input. */
    fun confirmProbe(code: String) {
        val r = g.client.confirm(code)
        if (r is ApiResult.Ok) s.set(Settings.K.UP_VERIFIED, true)
    }

    // ---- misc -----------------------------------------------------------------------------

    fun purgeHistory() {
        val days = s.historyDays
        dao.purgeHistory(System.currentTimeMillis() - days * 86_400_000L)
    }

    /** Direct share targets: one long-lived dynamic shortcut per member of the All set. */
    fun updateShortcuts() {
        val ctx = g.app
        if (!s.directShare) { ShortcutManagerCompat.removeAllDynamicShortcuts(ctx); return }
        val all = allSet(g.store.peers())
        val ids = all.map { it.id }.toSet()
        val stale = ShortcutManagerCompat.getDynamicShortcuts(ctx).map { it.id }.filter { it !in ids }
        if (stale.isNotEmpty()) ShortcutManagerCompat.removeDynamicShortcuts(ctx, stale)
        for (p in all) {
            val label = p.name ?: "Device"
            val sc = ShortcutInfoCompat.Builder(ctx, p.id).setShortLabel(label).setLongLived(true)
                .setIcon(IconCompat.createWithResource(ctx, R.drawable.ic_notify))
                .setCategories(setOf("com.pusharmor.category.SHARE_TARGET"))
                .setPerson(Person.Builder().setName(label).build())
                .setIntent(Intent(ctx, ShareActivity::class.java).setAction(Intent.ACTION_SEND)).build()
            ShortcutManagerCompat.pushDynamicShortcut(ctx, sc)
        }
    }
}
