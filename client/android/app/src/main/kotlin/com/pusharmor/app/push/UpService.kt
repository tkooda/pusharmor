package com.pusharmor.app.push

import com.pusharmor.app.PaApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.work.Work
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
        val text = text(message.content) ?: return
        // The probe: {"probe":"$code"}; answered at once, never shown.
        val probe = (StrictJson.parseOrNull(text) as? JValue.JObject)?.fields?.get("probe") as? JValue.JString
        // The connector calls onMessage on the main thread, and the process may die once it returns:
        // an expedited job does the Room, DataStore and OkHttp work (I404).
        Work.upPush(this, probe?.value, if (probe == null) text.trim() else null)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        g.settings.set(Settings.K.BANNER, "no_distributor:${reason.name}")
    }

    override fun onUnregistered(instance: String) {
        UnifiedPushSupport.clearEndpoint(g)
        UnifiedPushSupport.register(g)
    }

    companion object {
        /**
         * 1..4096 bytes of ASCII, else null (dropped). A byte above 0x7F would decode to U+FFFD, 3 bytes
         * in the job input, and 4096 of them pass the 10 KB WorkManager Data limit and crash (I407).
         */
        fun text(content: ByteArray): String? =
            if (content.isEmpty() || content.size > 4096 || content.any { it < 0 }) null else String(content, Charsets.US_ASCII)
    }
}
