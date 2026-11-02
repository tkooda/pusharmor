package com.pusharmor.app

import android.security.keystore.KeyGenParameterSpec
import com.pusharmor.crypto.P256
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyPair
import java.security.KeyPairGeneratorSpi
import java.security.KeyStore
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Security
import java.security.cert.Certificate
import java.security.spec.AlgorithmParameterSpec
import java.util.Collections
import java.util.Date
import java.util.Enumeration
import javax.crypto.KeyAgreement
import javax.crypto.KeyAgreementSpi
import javax.crypto.SecretKey

/**
 * A software "AndroidKeyStore" for Robolectric (which has none): EC key generation by alias and
 * the KeyStore calls KeystoreKeyOps makes. Install in a test, remove after it.
 */
object FakeAndroidKeyStore {
    private const val NAME = "AndroidKeyStore"
    private val keys = Collections.synchronizedMap(LinkedHashMap<String, KeyPair>())

    /** Every entry read and alias lookup throws, as a Keystore that fails to answer. */
    @Volatile var storeFault = false
    /** Private key reads throw, so the keys are listed but cannot sign or agree. */
    @Volatile var keyFault = false

    fun install() { keys.clear(); storeFault = false; keyFault = false; Security.removeProvider(NAME); Security.addProvider(P()) }
    fun remove() { Security.removeProvider(NAME); keys.clear(); storeFault = false; keyFault = false }

    private fun checkStore() { if (storeFault) throw java.security.ProviderException("keystore fault") }

    private class P : @Suppress("DEPRECATION") Provider(NAME, 1.0, "test keystore") {
        init {
            putService(object : Service(this, "KeyStore", NAME, Spi::class.java.name, null, null) {
                override fun newInstance(constructorParameter: Any?): Any = Spi()
            })
            putService(object : Service(this, "KeyPairGenerator", "EC", Gen::class.java.name, null, null) {
                override fun newInstance(constructorParameter: Any?): Any = Gen()
            })
            putService(object : Service(this, "KeyAgreement", "ECDH", Agree::class.java.name, null, null) {
                override fun newInstance(constructorParameter: Any?): Any = Agree()
                override fun supportsParameter(parameter: Any?) = true
            })
        }
    }

    /** ECDH by a software provider, for the keys this fake holds. */
    private class Agree : KeyAgreementSpi() {
        private val ka = KeyAgreement.getInstance("ECDH", Security.getProviders("KeyAgreement.ECDH").first { it.name != NAME })
        override fun engineInit(key: Key, random: SecureRandom?) = ka.init(key, random)
        override fun engineInit(key: Key, params: AlgorithmParameterSpec?, random: SecureRandom?) = ka.init(key, params, random)
        override fun engineDoPhase(key: Key, lastPhase: Boolean): Key? = ka.doPhase(key, lastPhase)
        override fun engineGenerateSecret(): ByteArray = ka.generateSecret()
        override fun engineGenerateSecret(sharedSecret: ByteArray, offset: Int): Int = ka.generateSecret(sharedSecret, offset)
        override fun engineGenerateSecret(algorithm: String): SecretKey = ka.generateSecret(algorithm)
    }

    private class Cert(private val pub: PublicKey) : Certificate("fake") {
        override fun getEncoded(): ByteArray = pub.encoded
        override fun verify(key: PublicKey?) {}
        override fun verify(key: PublicKey?, sigProvider: String?) {}
        override fun toString() = "fake"
        override fun getPublicKey(): PublicKey = pub
    }

    private class Gen : KeyPairGeneratorSpi() {
        private var alias: String? = null
        override fun initialize(keysize: Int, random: SecureRandom?) = throw UnsupportedOperationException()
        override fun initialize(params: AlgorithmParameterSpec?, random: SecureRandom?) { alias = (params as KeyGenParameterSpec).keystoreAlias }
        override fun generateKeyPair(): KeyPair {
            val kp = P256.generateSoftware()
            keys[alias!!] = kp
            return kp
        }
    }

    private class Spi : KeyStoreSpi() {
        override fun engineGetKey(alias: String, password: CharArray?): Key? {
            checkStore()
            if (keyFault) throw java.security.UnrecoverableKeyException("key fault")
            return keys[alias]?.private
        }
        override fun engineGetCertificateChain(alias: String): Array<Certificate>? = engineGetCertificate(alias)?.let { arrayOf(it) }
        override fun engineGetCertificate(alias: String): Certificate? = keys[alias]?.let { Cert(it.public) }
        override fun engineGetCreationDate(alias: String): Date? = if (alias in keys) Date(0) else null
        override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<out Certificate>?) = throw UnsupportedOperationException()
        override fun engineSetKeyEntry(alias: String, key: ByteArray, chain: Array<out Certificate>?) = throw UnsupportedOperationException()
        override fun engineSetCertificateEntry(alias: String, cert: Certificate) = throw UnsupportedOperationException()
        override fun engineDeleteEntry(alias: String) { keys.remove(alias) }
        override fun engineAliases(): Enumeration<String> = Collections.enumeration(keys.keys.toList())
        override fun engineContainsAlias(alias: String): Boolean { checkStore(); return alias in keys }
        override fun engineSize() = keys.size
        override fun engineIsKeyEntry(alias: String) = alias in keys
        override fun engineIsCertificateEntry(alias: String) = false
        override fun engineGetCertificateAlias(cert: Certificate): String? = null
        override fun engineStore(stream: OutputStream?, password: CharArray?) {}
        override fun engineLoad(stream: InputStream?, password: CharArray?) {}
        override fun engineGetEntry(alias: String, protParam: KeyStore.ProtectionParameter?): KeyStore.Entry? {
            checkStore()
            return keys[alias]?.let { KeyStore.PrivateKeyEntry(it.private, arrayOf(Cert(it.public))) }
        }
    }
}
