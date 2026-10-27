package com.pusharmor.protocol

import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NamePairTest {
    private val a = TestPeer()
    private val b = TestPeer()
    private val pid = ByteArray(8) { 4 }

    @Test fun nameEntryRoundTripAndSignedString() {
        val e = NameEntry.buildClear(a.keys, a.id, b.id, pid, 12, "My Phone")
        assertEquals("PA-NAME1\n${a.id}\n${b.id}\n${B64url.encode(pid)}\n12\n${e.nameB64}",
            String(NameEntry.signedBytes(a.id, b.id, pid, 12, e.nameB64)))
        val ct = NameEntry.seal(e, b.id, b.keys.encPub)
        assertTrue(ct.length <= 1024)
        val opened = NameEntry.open(ct, b.keys, b.id)!!
        assertEquals(e, opened)
        assertEquals("My Phone", NameEntry.verify(opened, a.keys.signPub, a.id, b.id, pid))
        assertNull(NameEntry.verify(opened, a.keys.signPub, a.id, b.id, ByteArray(8))) // earlier pairing
        assertNull(NameEntry.verify(opened.copy(n = 13), a.keys.signPub, a.id, b.id, pid))
        assertNull(NameEntry.open(ct, a.keys, a.id))
    }

    @Test fun nameRules() {
        assertTrue(NameEntry.isValidName("a"))
        assertTrue(NameEntry.isValidName("x".repeat(32)))
        assertTrue(!NameEntry.isValidName(""))
        assertTrue(!NameEntry.isValidName("x".repeat(33)))
        assertTrue(!NameEntry.isValidName("a\tb"))
        assertTrue(!NameEntry.isValidName("\u00e9"))
    }

    @Test fun pairMessages() {
        val rN = ByteArray(32) { 1 }
        val cN = Ids.commit(a.keys.signPub, a.keys.encPub, rN)
        val commit = PairMessage.seal(PairMessage.Commit(a.idRaw, cN), b.id, b.keys.encPub)
        assertEquals(366, commit.length)
        val oc = PairMessage.open(commit, b.keys, b.id, TestPeer.ACCOUNT) as PairMessage.Commit
        assertArrayEquals(cN, oc.cN)
        assertArrayEquals(a.idRaw, oc.fromId)
        assertNull(PairMessage.open(commit, b.keys, b.id, TestPeer.ACCOUNT, PairKind.REPLY)) // outer kind mismatch
        assertNull(PairMessage.open(commit, b.keys, b.id, ByteArray(9))) // other account

        val reply = PairMessage.seal(PairMessage.Keys(PairKind.REPLY, b.idRaw, b.keys.signPub, b.keys.encPub, ByteArray(32) { 2 }), a.id, a.keys.encPub)
        val or = PairMessage.open(reply, a.keys, a.id, TestPeer.ACCOUNT) as PairMessage.Keys
        assertEquals(PairKind.REPLY, or.kind)
        // keys that do not hash to the from id
        val bad = PairMessage.seal(PairMessage.Keys(PairKind.OPEN, b.idRaw, a.keys.signPub, a.keys.encPub, rN), a.id, a.keys.encPub)
        assertNull(PairMessage.open(bad, a.keys, a.id, TestPeer.ACCOUNT))
        // wrong size
        assertNull(PairMessage.open(reply + "AAAA", a.keys, a.id, TestPeer.ACCOUNT))
        assertNull(PairMessage.open(reply, b.keys, b.id, TestPeer.ACCOUNT)) // wrong recipient
    }
}
