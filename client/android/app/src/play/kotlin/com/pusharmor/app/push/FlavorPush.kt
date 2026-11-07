package com.pusharmor.app.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import com.pusharmor.app.Graph
import com.pusharmor.app.data.Settings
import com.pusharmor.app.work.Work
import org.unifiedpush.android.connector.UnifiedPush
import java.util.concurrent.TimeUnit

/** play flavor: FCM when Google Play services are present, else UnifiedPush. */
class FlavorPush(private val context: Context) : PushFlavor {
    companion object {
        fun create(context: Context): PushFlavor = FlavorPush(context)

        /** Turns FCM's own token fetch on or off; a test replaces it (no Firebase app runs in unit tests). */
        internal var autoInit: (Boolean) -> Unit = { FirebaseMessaging.getInstance().isAutoInitEnabled = it }

        /** The FCM token request; a test replaces it. */
        internal var tokenTask: () -> Task<String> = { FirebaseMessaging.getInstance().token }

        /** Fetches the FCM token and waits for it (off the main thread): a failure throws, so the tap that asked says so; a test replaces it. */
        internal var fetchToken: ((String) -> Unit) -> Unit = { cb -> cb(Tasks.await(tokenTask(), 30, TimeUnit.SECONDS)) }
    }

    override val hasPlayServices: Boolean
        get() = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS

    override fun canServe(type: String) = type == "fcm" || type == "unifiedpush"

    override fun start(g: Graph) {
        // A stored UnifiedPush registration is honoured; never auto-switch to FCM.
        val type = g.settings.get(Settings.K.PUSH_TYPE)
        if (type == "unifiedpush" || (type == null && !hasPlayServices)) { UnifiedPushSupport.register(g); return }
        autoInit(true)
        // No token: the cannot-receive card says so, and the next app start or Check again asks again.
        tokenTask().addOnSuccessListener { token -> onToken(g, token) }.addOnFailureListener { UnifiedPushSupport.setupFailed(g, "fcm_token") }
    }

    fun onToken(g: Graph, token: String) {
        val s = g.settings
        if (s.get(Settings.K.PUSH_TYPE) == "unifiedpush") return
        s.set(Settings.K.PUSH_TYPE, "fcm")
        UnifiedPushSupport.clearNoDistributor(g)
        UnifiedPushSupport.setupOk(g)
        if (s.get(Settings.K.PUSH_TOKEN) != token) { s.set(Settings.K.PUSH_TOKEN, token); Work.patchPush(g.app) }
    }

    override fun switchToUnifiedPush(g: Graph) {
        FirebaseMessaging.getInstance().deleteToken()
        FirebaseMessaging.getInstance().isAutoInitEnabled = false
        g.settings.set(Settings.K.PUSH_TOKEN, null)
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        // The address is then always stored and sent, even when it equals the one before.
        UnifiedPushSupport.clearEndpoint(g)
        UnifiedPushSupport.register(g)
    }

    override fun switchToGoogle(g: Graph) {
        // The token comes first: a failed fetch throws with UnifiedPush still in place, so Push method still shows it and picking Google tries again.
        autoInit(true)
        var token: String? = null
        try { fetchToken { token = it } } catch (e: Exception) { if (UnifiedPushSupport.active(g)) autoInit(false); throw e }
        UnifiedPush.unregister(context, UnifiedPushSupport.INSTANCE)
        UnifiedPushSupport.clearEndpoint(g)
        g.settings.set(Settings.K.PUSH_TYPE, null)
        UnifiedPushSupport.clearNoDistributor(g)
        // The token is then always sent, even when it equals the one before the switch to UnifiedPush.
        g.settings.set(Settings.K.PUSH_TOKEN, null)
        token?.let { onToken(g, it) }
    }

    /** Wipe: called after the DataStore clear, so both methods are stopped. */
    override fun stop(g: Graph) {
        try { UnifiedPush.unregister(context, UnifiedPushSupport.INSTANCE) } catch (e: Exception) { }
        try { FirebaseMessaging.getInstance().deleteToken() } catch (e: Exception) { }
        // Without this FCM fetches a new token on its own after the wipe.
        try { autoInit(false) } catch (e: Exception) { }
    }
}
