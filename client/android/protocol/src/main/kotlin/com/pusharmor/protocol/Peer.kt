package com.pusharmor.protocol

/**
 * Local view of one peer (the Room "peers" row). Pins come only from a completed pairing,
 * never from GET /peers.
 */
data class Peer(
    val id: String,
    val platform: String = "",
    val created: Long = 0,
    /** Keys listed by the last GET /peers (used to address pair messages); not trusted. */
    val listSignPub: String? = null,
    val listEncPub: String? = null,
    /** Pinned keys (exact strings) and pairing id, set by a completed pairing. */
    val signPub: String? = null,
    val encPub: String? = null,
    val pairingId: ByteArray? = null,
    /** I approved this peer. */
    val approved: Boolean = false,
    /** I denied this peer. */
    val deniedByMe: Boolean = false,
    /** This peer's signed approve verified on this device. */
    val approveVerified: Boolean = false,
    /** approves_me / denies_me from the last GET /peers, and whether that GET was fetched after approveVerified. */
    val listApprovesMe: Boolean = false,
    val listDeniesMe: Boolean = false,
    val listAfterVerify: Boolean = false,
    /** A signed deny from this peer was received ("Declined by $X"). */
    val declined: Boolean = false,
    val reachable: Boolean = true,
    val loggedOut: Boolean = false,
    val logoutN: Long = 0,
    val hidden: Boolean = false,
    val name: String? = null,
    val nameN: Long = 0,
    val removed: Boolean = false,
    val missing: Boolean = false,
    /** Send counter to this peer. */
    val lastN: Long = 0,
    val channelId: String? = null,
    /** Stored approve request (exact bytes) for the re-fetch while waiting, and the own name it carried. */
    val storedApprove: String? = null,
    val storedApproveName: String? = null,
    /** Last approve/deny result word, for "Send again" rules. */
    val lastApproveResult: String? = null,
    val lastSendAt: Long = 0,
    /** Row line after an aborted or timed-out pairing ("Pairing failed. ..." / "Pairing timed out. ..."). */
    val note: String? = null,
    /** This device got the "wants to pair again" notice for this row; cleared by Cancel pairing and by a new pairing. */
    val pairAgain: Boolean = false,
) {
    val pinned: Boolean get() = signPub != null && encPub != null && pairingId != null

    /** "approves me": a verified approve; once a GET fetched after it exists, that GET decides. */
    val approvesMe: Boolean get() = approveVerified && (!listAfterVerify || listApprovesMe)

    /** "Waiting for $X": I approved, X's approve has not verified. */
    val waiting: Boolean get() = pinned && approved && !approveVerified

    /** Pinned row with no open entry that offers Cancel pairing ("Not paired on $X" / "Declined by $X"). */
    val notPairedOnPeer: Boolean get() = pinned && approveVerified && listAfterVerify && !listApprovesMe

    /** Row offers [Pair again]: the pair-again notice fired and the row is still in the half state. */
    val offersPairAgain: Boolean get() = pairAgain && (waiting || notPairedOnPeer)

    /** Member of the catalog "All" set. */
    val inAll: Boolean get() = pinned && approved && approvesMe && !hidden && !loggedOut && !missing && !removed
}

/** The catalog "All" set (one definition for every client). */
fun allSet(peers: Collection<Peer>): List<Peer> = peers.filter { it.inAll }
