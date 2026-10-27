package com.pusharmor.app.push

import android.content.Context
import com.pusharmor.app.Graph
import com.pusharmor.app.data.Settings
import com.pusharmor.app.work.Work
import com.pusharmor.app.BuildConfig
import com.pusharmor.crypto.B64url
import com.pusharmor.net.WorkerClient
import org.unifiedpush.android.connector.UnifiedPush

/** Push method per flavor (section 5). play: FCM + UnifiedPush; foss: UnifiedPush only. */
interface PushFlavor {
    /** foss holds the constant "no Play services". */
    val hasPlayServices: Boolean

    /** The flavor can serve this push type. */
    fun canServe(type: String): Boolean

    /** Start of the chosen method (token fetch or distributor registration). */
    fun start(g: Graph)

    fun switchToUnifiedPush(g: Graph)
    fun switchToGoogle(g: Graph)

    /** Wipe: deleteToken() on FCM or UnifiedPush.unregister(). */
    fun stop(g: Graph)

    fun distributorCheck(g: Graph) = UnifiedPushSupport.distributorCheck(g)

    companion object {
        fun create(context: Context): PushFlavor = FlavorPush.create(context)
    }
}

/** UnifiedPush through the connector 3.x library (both flavors). */
object UnifiedPushSupport {
    const val INSTANCE = "default"

    fun register(g: Graph) {
        val c = g.app
        UnifiedPush.tryUseCurrentOrDefaultDistributor(c) { ok ->
            if (ok) UnifiedPush.register(c, INSTANCE, null, BuildConfig.VAPID_PUBLIC_KEY.ifEmpty { null })
            else g.settings.set(Settings.K.BANNER, "no_distributor")
        }
    }

    fun distributors(context: Context): List<String> = UnifiedPush.getDistributors(context)

    fun pick(g: Graph, distributor: String) {
        UnifiedPush.saveDistributor(g.app, distributor)
        UnifiedPush.register(g.app, INSTANCE, null, BuildConfig.VAPID_PUBLIC_KEY.ifEmpty { null })
    }

    /** On app start and daily: saved distributor gone -> clear endpoint + banner; else register again (idempotent). */
    fun distributorCheck(g: Graph) {
        if (g.settings.get(Settings.K.PUSH_TYPE) != "unifiedpush") return
        val saved = UnifiedPush.getSavedDistributor(g.app)
        if (saved == null || saved !in UnifiedPush.getDistributors(g.app)) {
            clearEndpoint(g)
            g.settings.set(Settings.K.BANNER, "no_distributor")
        } else {
            UnifiedPush.register(g.app, INSTANCE, null, BuildConfig.VAPID_PUBLIC_KEY.ifEmpty { null })
        }
    }

    fun clearEndpoint(g: Graph) {
        g.settings.set(Settings.K.UP_ENDPOINT, null); g.settings.set(Settings.K.UP_P256DH, null); g.settings.set(Settings.K.UP_AUTH, null)
        g.settings.set(Settings.K.UP_VERIFIED, false)
    }

    /** Lenient decode of the library's base64 (padding or not), re-encoded as strict b64url. */
    fun strict(b64: String): String? {
        val t = b64.trimEnd('=').replace('+', '-').replace('/', '_')
        return B64url.decodeOrNull(t)?.let { B64url.encode(it) }
    }

    /** New endpoint: PATCH only when endpoint or keys differ from the stored ones. */
    fun onNewEndpoint(g: Graph, url: String, pubKey: String?, auth: String?) {
        val p = pubKey?.let { strict(it) } ?: return
        val a = auth?.let { strict(it) } ?: return
        val s = g.settings
        if (s.get(Settings.K.UP_ENDPOINT) == url && s.get(Settings.K.UP_P256DH) == p && s.get(Settings.K.UP_AUTH) == a) return
        s.set(Settings.K.UP_ENDPOINT, url); s.set(Settings.K.UP_P256DH, p); s.set(Settings.K.UP_AUTH, a)
        s.set(Settings.K.PUSH_TYPE, "unifiedpush")
        s.set(Settings.K.UP_VERIFIED, false)
        s.set(Settings.K.UP_REGISTERED_AT, System.currentTimeMillis())
        s.set(Settings.K.BANNER, null)
        Work.patchPush(g.app)
    }

    fun pushJson(g: Graph): Pair<String, List<String>>? {
        val s = g.settings
        val e = s.get(Settings.K.UP_ENDPOINT) ?: return null
        val p = s.get(Settings.K.UP_P256DH) ?: return null
        val a = s.get(Settings.K.UP_AUTH) ?: return null
        return WorkerClient.obj("type" to WorkerClient.str("unifiedpush"), "endpoint" to WorkerClient.str(e), "p256dh" to WorkerClient.str(p), "auth" to WorkerClient.str(a)) to
            listOf("unifiedpush", e, p, a)
    }
}
