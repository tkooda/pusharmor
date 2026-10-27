package com.pusharmor.app.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Owner of the verified App Link https://pusharmor.com/auth/android. The ticket and email come
 * in the fragment (App Link) or the query (the intent:// fallback cannot carry a fragment).
 */
class AuthLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent.data
        val (ticket, email) = parse(data)
        if (ticket != null) {
            startActivity(Intent(this, MainActivity::class.java).putExtra("ticket", ticket).putExtra("email", email)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }

    companion object {
        fun parse(uri: Uri?): Pair<String?, String?> {
            if (uri == null || uri.host != "pusharmor.com" || uri.path != "/auth/android") return null to null
            val frag = uri.encodedFragment?.let { Uri.parse("x://h/?$it") }
            val ticket = frag?.getQueryParameter("ticket") ?: uri.getQueryParameter("ticket")
            val email = frag?.getQueryParameter("email") ?: uri.getQueryParameter("email")
            return ticket to email
        }
    }
}
