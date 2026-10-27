package com.pusharmor.app.push

import android.content.Context
import com.pusharmor.app.Graph
import org.unifiedpush.android.connector.UnifiedPush

/** foss flavor: no Google code at all; UnifiedPush only. */
class FlavorPush(private val context: Context) : PushFlavor {
    companion object {
        fun create(context: Context): PushFlavor = FlavorPush(context)
    }

    override val hasPlayServices: Boolean = false

    override fun canServe(type: String) = type == "unifiedpush"

    override fun start(g: Graph) = UnifiedPushSupport.register(g)

    override fun switchToUnifiedPush(g: Graph) = Unit

    override fun switchToGoogle(g: Graph) = Unit

    override fun stop(g: Graph) {
        try { UnifiedPush.unregister(context, UnifiedPushSupport.INSTANCE) } catch (e: Exception) { }
    }
}
