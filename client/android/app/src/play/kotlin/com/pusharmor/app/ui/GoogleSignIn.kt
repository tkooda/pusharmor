package com.pusharmor.app.ui

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.pusharmor.app.BuildConfig

/** Google sign-in with Play services: Credential Manager with the PushArmor nonce; closing the account picker throws [GoogleSignInCancelled]. */
object GoogleSignIn {
    suspend fun idToken(activity: Activity, nonce: String): String? = try {
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
            .setFilterByAuthorizedAccounts(false)
            .setNonce(nonce)
            .build()
        val r = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(option).build())
        GoogleIdTokenCredential.createFrom(r.credential.data).idToken
    } catch (e: GetCredentialCancellationException) {
        throw GoogleSignInCancelled()
    } catch (e: Exception) {
        null
    }
}
