package com.pusharmor.app

import android.content.ComponentName
import androidx.work.Configuration
import androidx.work.WorkManager
import org.robolectric.Shadows.shadowOf

/** PaApp with WorkManager and Room set up for Robolectric (the manifest disables WorkManager's auto start; its instance outlives one test). */
class TestApp : PaApp() {
    override fun onCreate() {
        // Robolectric hands Room's invalidation service a null name; keep it unbound.
        shadowOf(this).declareComponentUnbindable(ComponentName(this, "androidx.room.MultiInstanceInvalidationService"))
        if (!WorkManager.isInitialized()) WorkManager.initialize(this, Configuration.Builder().setExecutor { it.run() }.build())
        super.onCreate()
    }
}
