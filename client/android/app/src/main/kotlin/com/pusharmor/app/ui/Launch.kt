package com.pusharmor.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast

const val NO_APP_LINK = "No app can open this URL."
const val NO_APP_DIAL = "No app can call this number."

/**
 * Starts [intent]; with no app to handle it (no browser, dialer, or store), shows [text] instead of crashing.
 * [show] is a Toast only where the screen closes at once; app screens pass their snackbar.
 */
fun startOrToast(context: Context, intent: Intent, text: String = NO_APP_LINK,
                 show: (String) -> Unit = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }) {
    try { context.startActivity(intent) } catch (e: ActivityNotFoundException) { show(text) }
}

/** Starts [intent]; with no app to handle it, does nothing instead of crashing. */
fun safeStart(context: Context, intent: Intent) {
    try { context.startActivity(intent) } catch (e: ActivityNotFoundException) { }
}
