package com.pusharmor.app.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.messaging.FirebaseMessaging
import com.pusharmor.app.Graph
import com.pusharmor.app.data.Settings
import com.pusharmor.app.work.Work
import org.unifiedpush.android.connector.UnifiedPush

/** play flavor: FCM when Google Play services are present, else UnifiedPush. */
class FlavorPush(private val context: Context) : PushFlavor {
    companion object {
        fun create(context: Context): PushFlavor = FlavorPush(context)
    }

    override val hasPlayServices: Boolean
        get() = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS

    override fun canServe(type: String) = type == "fcm" || type == "unifiedpush"

    override fun start(g: Graph) {
        // A stored UnifiedPush registration is honoured; never auto-switch to FCM.
        val type = g.settings.get(Settings.K.PUSH_TYPE)
        if (type == "unifiedpush" || (type == null && !hasPlayServices)) { UnifiedPushSupport.register(g); return }
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> onToken(g, token) }
    }

    fun onToken(g: Graph, token: String) {
        val s = g.settings
        if (s.get(Settings.K.PUSH_TYPE) == "unifiedpush") return
        s.set(Settings.K.PUSH_TYPE, "fcm")
        if (s.get(Settings.K.PUSH_TOKEN) != token) { s.set(Settings.K.PUSH_TOKEN, token); Work.patchPush(g.app) }
    }

    override fun switchToUnifiedPush(g: Graph) {
        FirebaseMessaging.getInstance().deleteToken()
        FirebaseMessaging.getInstance().isAutoInitEnabled = false
        g.settings.set(Settings.K.PUSH_TOKEN, null)
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush")
        UnifiedPushSupport.register(g)
    }

    override fun switchToGoogle(g: Graph) {
        UnifiedPush.unregister(context, UnifiedPushSupport.INSTANCE)
        UnifiedPushSupport.clearEndpoint(g)
        g.settings.set(Settings.K.PUSH_TYPE, null)
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnSuccessListener { onToken(g, it) }
    }

    /** Wipe: called after the DataStore clear, so both methods are stopped. */
    override fun stop(g: Graph) {
        try { UnifiedPush.unregister(context, UnifiedPushSupport.INSTANCE) } catch (e: Exception) { }
        try { FirebaseMessaging.getInstance().deleteToken() } catch (e: Exception) { }
    }
}
