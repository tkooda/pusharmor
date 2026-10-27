package com.pusharmor.app.ui

import android.app.Activity

/** foss: no Play services; Google sign-in always uses the Custom Tab flow. */
object GoogleSignIn {
    @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
    suspend fun idToken(activity: Activity, nonce: String): String? = null
}
