package com.pusharmor.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast

const val NO_APP_LINK = "No app can open this link."
const val NO_APP_DIAL = "No app can dial this number."

/** Starts [intent]; with no app to handle it (no browser, dialer, or store), shows [text] instead of crashing (I550). */
fun startOrToast(context: Context, intent: Intent, text: String = NO_APP_LINK) {
    try { context.startActivity(intent) } catch (e: ActivityNotFoundException) { Toast.makeText(context, text, Toast.LENGTH_SHORT).show() }
}
