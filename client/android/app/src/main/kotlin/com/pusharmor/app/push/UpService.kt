package com.pusharmor.app.push

import com.pusharmor.app.PaApp
import com.pusharmor.app.data.Settings
import com.pusharmor.protocol.JValue
import com.pusharmor.protocol.StrictJson
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** UnifiedPush receiver (connector 3.x). The library decrypts RFC 8291; HPKE follows. */
class UpService : PushService() {
    private val g get() = (application as PaApp).graph

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        UnifiedPushSupport.onNewEndpoint(g, endpoint.url, endpoint.pubKeySet?.pubKey, endpoint.pubKeySet?.auth)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) return // drop silently
        val text = try { String(message.content, Charsets.US_ASCII) } catch (e: Exception) { return }
        if (message.content.isEmpty() || message.content.size > 4096) return
        // The probe: {"probe":"$code"}; answered at once, never shown.
        val probe = (StrictJson.parseOrNull(text) as? JValue.JObject)?.fields?.get("probe") as? JValue.JString
        if (probe != null) { g.session.confirmProbe(probe.value); return }
        PushDispatcher.onPush(g, text.trim(), fcm = false)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        g.settings.set(Settings.K.BANNER, "no_distributor:${reason.name}")
    }

    override fun onUnregistered(instance: String) {
        UnifiedPushSupport.clearEndpoint(g)
        UnifiedPushSupport.register(g)
    }
}
