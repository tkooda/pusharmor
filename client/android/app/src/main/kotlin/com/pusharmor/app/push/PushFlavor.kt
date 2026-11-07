package com.pusharmor.app.push

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import com.pusharmor.app.Graph
import com.pusharmor.app.data.Settings
import com.pusharmor.app.ui.UiText
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

    /** The installed UnifiedPush apps; a test replaces it. */
    internal var installed: (Context) -> List<String> = { UnifiedPush.getDistributors(it) }

    /** The UnifiedPush app in use; a test replaces it. */
    internal var saved: (Context) -> String? = { UnifiedPush.getSavedDistributor(it) }

    fun register(g: Graph) {
        val c = g.app
        UnifiedPush.tryUseCurrentOrDefaultDistributor(c) { ok ->
            if (ok) UnifiedPush.register(c, INSTANCE, null, BuildConfig.VAPID_PUBLIC_KEY.ifEmpty { null })
            else if (active(g)) g.settings.set(Settings.K.BANNER, "no_distributor")
        }
    }

    fun distributors(context: Context): List<String> = installed(context)

    /** UnifiedPush is the push method in use: chosen, or the default without Google Play services. */
    fun active(type: String?, playServices: Boolean): Boolean = type == "unifiedpush" || (type == null && !playServices)

    fun active(g: Graph): Boolean = active(g.settings.get(Settings.K.PUSH_TYPE), g.push.hasPlayServices)

    /** Checked live on each return to the app: UnifiedPush is in use and no UnifiedPush app is installed. */
    fun noPushApp(context: Context, type: String?, playServices: Boolean): Boolean =
        active(type, playServices) && distributors(context).isEmpty()

    /** A UnifiedPush app installed since the last open: register with it, with no user step. */
    fun registerIfInstalled(g: Graph) {
        if (active(g) && g.settings.get(Settings.K.UP_ENDPOINT) == null && distributors(g.app).isNotEmpty()) register(g)
    }

    /** A stale "no UnifiedPush app" flag is dropped once Google is the push method. */
    fun clearNoDistributor(g: Graph) {
        if (g.settings.get(Settings.K.BANNER)?.startsWith("no_distributor") == true) g.settings.set(Settings.K.BANNER, null)
    }

    /** Push could not be set up for the method in use: line 2 of the cannot-receive card, else null. */
    fun setupError(context: Context, prefs: Preferences?, playServices: Boolean): String? {
        val code = prefs?.get(Settings.K.PUSH_SETUP) ?: return null
        val up = active(prefs[Settings.K.PUSH_TYPE], playServices)
        if (up == (code == "fcm_token")) return null
        return UiText.pushSetup(code, if (up) saved(context)?.let { appName(context, it) } else null)
    }

    /** Records a push setup failure ([Settings.K.PUSH_SETUP]); the cannot-receive card says it. */
    fun setupFailed(g: Graph, code: String) { if (g.settings.get(Settings.K.PUSH_SETUP) != code) g.settings.set(Settings.K.PUSH_SETUP, code) }

    /** A token or address arrived: a setup failure no longer holds. */
    fun setupOk(g: Graph) { if (g.settings.get(Settings.K.PUSH_SETUP) != null) g.settings.set(Settings.K.PUSH_SETUP, null) }

    /** The relay server refused the push address: its host and the UnifiedPush app's name, else null. */
    fun refused(context: Context, prefs: Preferences?, playServices: Boolean): Pair<String, String>? {
        if (prefs?.get(Settings.K.PUSH_REFUSED) != true || !active(prefs[Settings.K.PUSH_TYPE], playServices)) return null
        val host = prefs[Settings.K.UP_ENDPOINT]?.let { android.net.Uri.parse(it).host } ?: return null
        val pkg = saved(context) ?: return null
        return host to appName(context, pkg)
    }

    /** The app name of the UnifiedPush app [pkg], else the package name. */
    fun appName(context: Context, pkg: String): String {
        val pm = context.packageManager
        return try { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } catch (e: Exception) { pkg }
    }

    /**
     * Makes [distributor] the UnifiedPush app: the one in use before is unregistered first, so it stops pushing.
     * Registers at once while UnifiedPush is the push method; else the caller switches to UnifiedPush, which registers.
     */
    fun pick(g: Graph, distributor: String) {
        val old = saved(g.app)
        if (old != null && old != distributor) try { UnifiedPush.unregister(g.app, INSTANCE) } catch (e: Exception) { }
        // The new app's address is then always stored and sent, even when it equals the old one.
        clearEndpoint(g)
        UnifiedPush.saveDistributor(g.app, distributor)
        if (active(g)) UnifiedPush.register(g.app, INSTANCE, null, BuildConfig.VAPID_PUBLIC_KEY.ifEmpty { null })
    }

    /** On app start and daily: saved distributor gone -> clear endpoint + banner; else register again (idempotent). */
    fun distributorCheck(g: Graph) {
        if (g.settings.get(Settings.K.PUSH_TYPE) != "unifiedpush") return
        val saved = UnifiedPush.getSavedDistributor(g.app)
        if (saved == null || saved !in distributors(g.app)) {
            clearEndpoint(g)
            g.settings.set(Settings.K.BANNER, "no_distributor")
        } else {
            UnifiedPush.register(g.app, INSTANCE, null, BuildConfig.VAPID_PUBLIC_KEY.ifEmpty { null })
        }
    }

    fun clearEndpoint(g: Graph) {
        g.settings.set(Settings.K.UP_ENDPOINT, null); g.settings.set(Settings.K.UP_P256DH, null); g.settings.set(Settings.K.UP_AUTH, null)
        g.settings.set(Settings.K.UP_VERIFIED, false)
        g.settings.set(Settings.K.PUSH_REFUSED, false)
    }

    /** Lenient decode of the library's base64 (padding or not), re-encoded as strict b64url. */
    fun strict(b64: String): String? {
        val t = b64.trimEnd('=').replace('+', '-').replace('/', '_')
        return B64url.decodeOrNull(t)?.let { B64url.encode(it) }
    }

    /** New endpoint: PATCH only when endpoint or keys differ from the stored ones. */
    fun onNewEndpoint(g: Graph, url: String, pubKey: String?, auth: String?) {
        val p = pubKey?.let { strict(it) } ?: return setupFailed(g, "up_keys")
        val a = auth?.let { strict(it) } ?: return setupFailed(g, "up_keys")
        setupOk(g)
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
