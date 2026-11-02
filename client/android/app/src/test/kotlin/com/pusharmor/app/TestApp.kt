package com.pusharmor.app

import androidx.work.Configuration
import androidx.work.WorkManager
import com.pusharmor.net.WorkerClient
import okhttp3.Interceptor
import okhttp3.OkHttpClient

/** PaApp with WorkManager and Room set up for Robolectric (the manifest disables WorkManager's auto start; its instance outlives one test). */
class TestApp : PaApp() {
    /** Answers every relay server request when set; otherwise the request goes to the network as usual. */
    @Volatile var fakeHttp: Interceptor? = null

    /**
     * No invalidation service: Robolectric answers its bind and unbind with a null name on the main looper, and a
     * bind from a database a finished test opened late crashed a later test's idle.
     */
    override fun multiInstanceDb(): Boolean = false

    override fun httpClient(): OkHttpClient =
        WorkerClient.defaultHttp().newBuilder().addInterceptor { chain -> fakeHttp?.intercept(chain) ?: chain.proceed(chain.request()) }.build()

    override fun onCreate() {
        if (!WorkManager.isInitialized()) WorkManager.initialize(this, Configuration.Builder().setExecutor { it.run() }.build())
        super.onCreate()
    }
}
