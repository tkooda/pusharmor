package com.pusharmor.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import okhttp3.OkHttpClient
import java.io.IOException

/**
 * Store screenshot mode: sample data from the instrumented screenshot run, no Worker calls.
 * Debug builds only: every use sits behind the BuildConfig.SCREENSHOT_MODE constant, so a
 * release build drops this class (tools/check-release-apk.sh fails if it is present).
 */
object ScreenshotMode {
    @Volatile var on = false

    /** Draws the top bar title with alpha 0 (the 02 heads-up card leaves a sliver of its first letter); Compose state, so the open screen redraws. */
    var hideTitle by mutableStateOf(false)

    /** Send tab prefill for the screenshot run: message text and checked peer ids. */
    @Volatile var sendText = ""
    @Volatile var sendTo: List<String> = emptyList()

    /** Fails every Worker request while the mode is on (no 401 can wipe the sample data). */
    fun guard(http: OkHttpClient): OkHttpClient = http.newBuilder().addInterceptor { chain ->
        if (on) throw IOException("screenshot mode: no Worker calls")
        chain.proceed(chain.request())
    }.build()
}
