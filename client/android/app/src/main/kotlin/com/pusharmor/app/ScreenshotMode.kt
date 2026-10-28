package com.pusharmor.app

import okhttp3.OkHttpClient
import java.io.IOException

/**
 * Store screenshot mode: sample data from the instrumented screenshot run, no Worker calls.
 * Debug builds only: every use sits behind the BuildConfig.SCREENSHOT_MODE constant, so a
 * release build drops this class (tools/check-release-apk.sh fails if it is present).
 */
object ScreenshotMode {
    @Volatile var on = false

    /** Fails every Worker request while the mode is on (no 401 can wipe the sample data). */
    fun guard(http: OkHttpClient): OkHttpClient = http.newBuilder().addInterceptor { chain ->
        if (on) throw IOException("screenshot mode: no Worker calls")
        chain.proceed(chain.request())
    }.build()
}
