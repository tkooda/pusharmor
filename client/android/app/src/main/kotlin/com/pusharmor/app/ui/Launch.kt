package com.pusharmor.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast

const val NO_APP_LINK = "No app can open this link."
const val NO_APP_DIAL = "No app can dial this number."

/**
 * Starts [intent]; with no app to handle it (no browser, dialer, or store), shows [text] instead of crashing (I550).
 * [show] is a Toast only where the screen closes at once; app screens pass their snackbar (I603).
 */
fun startOrToast(context: Context, intent: Intent, text: String = NO_APP_LINK,
                 show: (String) -> Unit = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }) {
    try { context.startActivity(intent) } catch (e: ActivityNotFoundException) { show(text) }
}
