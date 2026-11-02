package com.pusharmor.app

import android.content.ComponentName
import androidx.work.Configuration
import androidx.work.WorkManager
import com.pusharmor.net.WorkerClient
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import org.robolectric.Shadows.shadowOf

/** PaApp with WorkManager and Room set up for Robolectric (the manifest disables WorkManager's auto start; its instance outlives one test). */
class TestApp : PaApp() {
    /** Answers every relay server request when set; otherwise the request goes to the network as usual. */
    @Volatile var fakeHttp: Interceptor? = null

    override fun httpClient(): OkHttpClient =
        WorkerClient.defaultHttp().newBuilder().addInterceptor { chain -> fakeHttp?.intercept(chain) ?: chain.proceed(chain.request()) }.build()

    override fun onCreate() {
        // Robolectric hands Room's invalidation service a null name; keep it unbound.
        shadowOf(this).declareComponentUnbindable(ComponentName(this, "androidx.room.MultiInstanceInvalidationService"))
        if (!WorkManager.isInitialized()) WorkManager.initialize(this, Configuration.Builder().setExecutor { it.run() }.build())
        super.onCreate()
    }
}
