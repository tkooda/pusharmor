package com.pusharmor.crypto

/**
 * Keys for one sign-in attempt: the in-memory keys, else keys already stored, else new ones.
 * Every call of the same attempt returns the same keys, so the OAuth nonce and sign_pub match.
 * [remember] receives keys that were loaded or created.
 */
fun signInKeys(current: KeyOps?, load: () -> KeyOps?, create: () -> KeyOps, remember: (KeyOps) -> Unit): KeyOps {
    if (current != null) return current
    val k = load() ?: create()
    remember(k)
    return k
}
