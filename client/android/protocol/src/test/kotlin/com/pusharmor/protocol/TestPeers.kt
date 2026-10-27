package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.crypto.KeyOps
import com.pusharmor.crypto.SoftwareKeyOps

/** A test peer with software keys and a valid id under a shared account. */
class TestPeer(val keys: KeyOps = SoftwareKeyOps.generate(), val account: ByteArray = ACCOUNT) {
    val idRaw: ByteArray = account + Ids.keyhash(keys.signPub, keys.encPub) + ByteArray(9) { 0x5a }
    val id: String = B64url.encode(idRaw)

    fun pin(pairingId: ByteArray) = PinnedKeys(keys.signPub, keys.encPub, pairingId)

    fun asPeer(pairingId: ByteArray, approved: Boolean = true, nameN: Long = 0, name: String? = null) = Peer(
        id = id, signPub = B64url.encode(keys.signPub), encPub = B64url.encode(keys.encPub), pairingId = pairingId,
        approved = approved, approveVerified = approved, name = name, nameN = nameN,
    )

    companion object {
        val ACCOUNT = ByteArray(9) { (it + 1).toByte() }
    }
}
