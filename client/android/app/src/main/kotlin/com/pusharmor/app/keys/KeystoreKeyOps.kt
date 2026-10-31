package com.pusharmor.app.keys

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.pusharmor.crypto.CryptoException
import com.pusharmor.crypto.KeyOps
import com.pusharmor.crypto.P256
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/**
 * Android Keystore keys (section 2): "pa.sign" (SIGN, SHA-256) and "pa.enc" (AGREE_KEY).
 * No user authentication, setUnlockedDeviceRequired(false), no StrongBox. Never exported.
 */
class KeystoreKeyOps private constructor(private val ks: KeyStore) : KeyOps {
    companion object {
        const val SIGN = "pa.sign"
        const val ENC = "pa.enc"

        private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        /** Both aliases present (getEntry not null for each). */
        fun present(): Boolean = store().let { it.getEntry(SIGN, null) != null && it.getEntry(ENC, null) != null }

        fun anyPresent(): Boolean = store().let { it.containsAlias(SIGN) || it.containsAlias(ENC) }

        fun deleteBoth() {
            val ks = store()
            for (a in listOf(SIGN, ENC)) if (ks.containsAlias(a)) ks.deleteEntry(a)
        }

        /** Deletes both aliases first, then makes new ones (first sign-in, removed, id collision). */
        fun createFresh(): KeystoreKeyOps {
            deleteBoth()
            gen(SIGN, KeyProperties.PURPOSE_SIGN) { it.setDigests(KeyProperties.DIGEST_SHA256) }
            gen(ENC, KeyProperties.PURPOSE_AGREE_KEY) { it }
            return KeystoreKeyOps(store())
        }

        internal inline fun <T> wrap(block: () -> T): T = try {
            block()
        } catch (e: CryptoException) {
            throw e
        } catch (e: Exception) {
            throw CryptoException("keystore: ${e.javaClass.simpleName}")
        }

        fun load(): KeystoreKeyOps? = if (present()) KeystoreKeyOps(store()) else null

        private fun gen(alias: String, purpose: Int, f: (KeyGenParameterSpec.Builder) -> KeyGenParameterSpec.Builder) {
            val spec = f(
                KeyGenParameterSpec.Builder(alias, purpose)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setUserAuthenticationRequired(false)
                    .setUnlockedDeviceRequired(false),
            ).build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        }
    }

    override val signPub: ByteArray = P256.point(ks.getCertificate(SIGN).publicKey)
    override val encPub: ByteArray = P256.point(ks.getCertificate(ENC).publicKey)

    /** Keystore returns DER; converted strictly to raw r||s. Keystore failures surface as CryptoException (I549). */
    override fun sign(data: ByteArray): ByteArray = wrap {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(ks.getKey(SIGN, null) as PrivateKey)
        s.update(data)
        P256.derToRaw(s.sign())
    }

    /** Keystore failures surface as CryptoException, so a push that cannot be opened is dropped (I299). */
    override fun ecdh(peerPoint: ByteArray): ByteArray = wrap {
        val ka = KeyAgreement.getInstance("ECDH", "AndroidKeyStore")
        ka.init(ks.getKey(ENC, null) as PrivateKey)
        ka.doPhase(P256.publicKey(peerPoint), true)
        ka.generateSecret()
    }
}
