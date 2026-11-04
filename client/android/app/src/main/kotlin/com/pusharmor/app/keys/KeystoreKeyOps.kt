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
 * Android Keystore keys (section 2): "<base>.sign" (SIGN, SHA-256) and "<base>.enc" (AGREE_KEY).
 * No user authentication, setUnlockedDeviceRequired(false), no StrongBox. Never exported.
 * Each account on the device has its own base; an archived account's keys stay under theirs.
 */
class KeystoreKeyOps private constructor(private val ks: KeyStore, private val signAlias: String = SIGN, private val encAlias: String = ENC) : KeyOps {
    companion object {
        /** The base of the first account's key set ("pa.sign", "pa.enc"). */
        const val LEGACY = "pa"
        /** The base of the active account's key set. */
        @Volatile var base = LEGACY
        val SIGN get() = "$base.sign"
        val ENC get() = "$base.enc"

        /** A base for a new account's key set, never one in use. */
        fun newBase(): String = LEGACY + "." + ByteArray(8).also { java.security.SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

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

        /** The saved keys still sign (checked against their public key) and still agree a key. Never deletes. */
        fun probe(): Boolean = try {
            val k = load()
            val d = ByteArray(32) { it.toByte() }
            k != null && P256.verify(k.signPub, d, k.sign(d)) && k.ecdh(k.encPub).size == 32
        } catch (e: Exception) {
            false
        }

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

    override val signPub: ByteArray = P256.point(ks.getCertificate(signAlias).publicKey)
    override val encPub: ByteArray = P256.point(ks.getCertificate(encAlias).publicKey)

    /** Keystore returns DER; converted strictly to raw r||s. Keystore failures surface as CryptoException. */
    override fun sign(data: ByteArray): ByteArray = wrap {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(ks.getKey(signAlias, null) as PrivateKey)
        s.update(data)
        P256.derToRaw(s.sign())
    }

    /** Keystore failures surface as CryptoException, so a push that cannot be opened is dropped. */
    override fun ecdh(peerPoint: ByteArray): ByteArray = wrap {
        val ka = KeyAgreement.getInstance("ECDH", "AndroidKeyStore")
        ka.init(ks.getKey(encAlias, null) as PrivateKey)
        ka.doPhase(P256.publicKey(peerPoint), true)
        ka.generateSecret()
    }
}
