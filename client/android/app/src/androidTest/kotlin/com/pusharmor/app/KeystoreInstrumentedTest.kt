package com.pusharmor.app

import android.os.Build
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Hpke
import com.pusharmor.crypto.KeyOps
import com.pusharmor.crypto.P256
import com.pusharmor.crypto.SoftwareKeyOps
import com.pusharmor.crypto.ascii
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.Certificate
import javax.crypto.KeyAgreement

/** Keystore path on a device or emulator (API 31 and the newest API): ECDH, DER conversion. */
@RunWith(AndroidJUnit4::class)
class KeystoreInstrumentedTest {
    @Test fun createSignVerifyAndEcdh() {
        val k = KeystoreKeyOps.createFresh()
        assertTrue(KeystoreKeyOps.present())
        repeat(50) {
            val sig = k.sign(ascii("data $it"))
            assertEquals(64, sig.size)
            assertTrue(P256.verify(k.signPub, ascii("data $it"), sig))
        }
        val other = SoftwareKeyOps.generate()
        val h = Hpke()
        val msg = h.seal(k.encPub, Hpke.INFO_MSG, ascii("aad"), ascii("hello"))
        assertArrayEquals(ascii("hello"), h.open(msg, k, Hpke.INFO_MSG, ascii("aad")))
        assertArrayEquals(other.ecdh(k.encPub), k.ecdh(other.encPub))
        KeystoreKeyOps.deleteBoth()
        assertTrue(!KeystoreKeyOps.anyPresent())
    }

    /**
     * Golden vectors through the Keystore ECDH path: the golden enc private key is imported
     * with KeyStore.setEntry and KeyProtection(PURPOSE_AGREE_KEY). The vector is the
     * rfc9180 section of tests/vectors/golden-v1.json (P-256, AES-256-GCM, base mode).
     * Skipped on API 31: an imported key does not get AGREE_KEY there, and keystore2 rejects
     * the ECDH begin ("the purpose is not authorized", KeyMint ErrorCode -3). The app never
     * imports keys; createSignVerifyAndEcdh covers ECDH with a generated key on API 31.
     */
    @Test fun goldenRfc9180ThroughKeystoreEcdh() {
        assumeTrue(Build.VERSION.SDK_INT != Build.VERSION_CODES.S)
        val skRm = "317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2"
        val pkEm = "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0"
        val ct = "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f"
        val kp = SoftwareKeyOps.keyPairFromScalar(hex(skRm))
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val cert: Certificate = selfSigned(kp)
        ks.setEntry("pa.test.enc", KeyStore.PrivateKeyEntry(kp.private, arrayOf(cert)), KeyProtection.Builder(KeyProperties.PURPOSE_AGREE_KEY).build())
        val keystoreKey = ks.getKey("pa.test.enc", null) as PrivateKey
        val ops = object : KeyOps {
            override val signPub = ByteArray(65)
            override val encPub = P256.pointOf(kp.public as java.security.interfaces.ECPublicKey)
            override fun sign(data: ByteArray) = error("unused")
            override fun ecdh(peerPoint: ByteArray): ByteArray = KeyAgreement.getInstance("ECDH", "AndroidKeyStore").run {
                init(keystoreKey); doPhase(P256.publicKey(peerPoint), true); generateSecret()
            }
        }
        val pt = Hpke().open(hex(pkEm + ct), ops, hex("4f6465206f6e2061204772656369616e2055726e"), hex("436f756e742d30"))
        assertEquals("4265617574792069732074727574682c20747275746820626561757479", pt.joinToString("") { "%02x".format(it) })
        ks.deleteEntry("pa.test.enc")
        assertEquals(B64url.encode(ByteArray(0)), "")
    }

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    /** Minimal self-signed certificate for the imported key (Keystore needs a chain). */
    private fun selfSigned(kp: java.security.KeyPair): Certificate {
        // Generate a throwaway Keystore key to borrow a certificate shape is not possible for an
        // imported key; Android accepts any X.509 certificate whose public key matches.
        val gen = java.security.KeyPairGenerator.getInstance("EC", "AndroidKeyStore")
        gen.initialize(android.security.keystore.KeyGenParameterSpec.Builder("pa.test.tmp", KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
        gen.generateKeyPair()
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val c = ks.getCertificate("pa.test.tmp")
        ks.deleteEntry("pa.test.tmp")
        return c
    }
}
