package com.pusharmor.protocol

import com.pusharmor.crypto.Ids

enum class PairRole { N, X }

/**
 * Pairing entry states. N: COMMITTED -> SHOWN. X: REPLIED or PROMPTED -> SHOWN.
 * PROMPTED = past the automatic reply cap (waits for a [Reply] tap) or an authorized reply
 * whose send failed (retried; [PairEntryView.authorized] tells them apart).
 */
enum class PairState { COMMITTED, PROMPTED, REPLIED, SHOWN }

/** The parts of an open pairing entry the commit decision reads. */
data class PairEntryView(
    val role: PairRole,
    val state: PairState,
    val cN: ByteArray?,
    val authorized: Boolean,
)

/** Where the from id stands against GET /peers (rule 3e). */
enum class Listed { YES, AFTER_FETCH, NO, NOT_FETCHED }

/** Inputs of the pure commit decision (pairing rules 3a-3e, I239). */
data class CommitInput(
    val ownId: ByteArray,
    val fromId: ByteArray,
    val cN: ByteArray,
    /** The open entry for that from id, if any (either role). */
    val entry: PairEntryView?,
    val pinned: Boolean,
    /** This device approved X (implies pinned). */
    val approved: Boolean,
    /** X's approve verified on this device. */
    val approveVerified: Boolean,
    /** approves_me of the last GET /peers (null if none), and whether that GET came after the verify. */
    val listApprovesMe: Boolean?,
    val listAfterVerify: Boolean,
    /** YES / AFTER_FETCH: listed; NO: still absent after one fetch; NOT_FETCHED: absent, fetch once first. */
    val listed: Listed,
    val openEntries: Int,
    /** Automatic reply timestamps (unix s). */
    val capTimestamps: List<Long>,
    /** unix s */
    val now: Long,
)

enum class PairAction { REPLY, NOTICE, ABORT, PROMPT, DROP, FETCH }

enum class PairNotice { COMMIT, HALF_STATE, CROSSING, COULD_NOT_READ, REPRESENT, NONE }

enum class EntryChange { CREATED_REPLIED, CREATED_PROMPTED, N_WIPED_X_REPLIED, ABORTED, UNCHANGED, NONE }

/** Output of the pure commit decision (golden pair_decide: action, notice, entry, cap_counted). */
data class PairDecision(val action: PairAction, val notice: PairNotice, val entry: EntryChange, val capCounted: Boolean)

object PairDecide {
    const val MAX_OPEN_ENTRIES = 9
    const val CAP = 10
    const val CAP_WINDOW_S = 86_400L

    /** Automatic replies counted at [now]: a timestamp t counts while now - t < 86400. */
    fun capCount(timestamps: List<Long>, now: Long): Int = timestamps.count { now - it < CAP_WINDOW_S }

    private val drop = PairDecision(PairAction.DROP, PairNotice.COULD_NOT_READ, EntryChange.UNCHANGED, false)
    private val half = PairDecision(PairAction.DROP, PairNotice.HALF_STATE, EntryChange.UNCHANGED, false)
    private val represent = PairDecision(PairAction.NOTICE, PairNotice.REPRESENT, EntryChange.UNCHANGED, false)

    fun commit(i: CommitInput): PairDecision {
        val e = i.entry
        // a / b: only an X-role entry from that id.
        if (e != null && e.role == PairRole.X) {
            if (e.cN != null && e.cN.contentEquals(i.cN)) {
                if (e.state != PairState.SHOWN && e.authorized) {
                    return PairDecision(PairAction.REPLY, PairNotice.REPRESENT, EntryChange.UNCHANGED, false)
                }
                return represent
            }
            // b applies before Approve; once this device approved, the pinned id falls to 3d.
            if (i.approved) return halfOrDrop(i)
            return PairDecision(PairAction.ABORT, PairNotice.COULD_NOT_READ, EntryChange.ABORTED, false)
        }
        // c: own N-role entry (crossing).
        if (e != null && e.role == PairRole.N) {
            if (e.state == PairState.COMMITTED) {
                return if (Ids.compareUnsigned(i.ownId, i.fromId) < 0) {
                    PairDecision(PairAction.DROP, PairNotice.CROSSING, EntryChange.UNCHANGED, false)
                } else {
                    PairDecision(PairAction.REPLY, PairNotice.COMMIT, EntryChange.N_WIPED_X_REPLIED, false)
                }
            }
            return if (i.approved && !i.approveVerified) half else drop
        }
        // d: pinned or approved, no entry matched.
        if (i.pinned || i.approved) return halfOrDrop(i)
        // e: new entry.
        when (i.listed) {
            Listed.NOT_FETCHED -> return PairDecision(PairAction.FETCH, PairNotice.NONE, EntryChange.NONE, false)
            Listed.NO -> return PairDecision(PairAction.DROP, PairNotice.COULD_NOT_READ, EntryChange.NONE, false)
            else -> Unit
        }
        if (i.openEntries >= MAX_OPEN_ENTRIES) return PairDecision(PairAction.DROP, PairNotice.COULD_NOT_READ, EntryChange.NONE, false)
        return if (capCount(i.capTimestamps, i.now) < CAP) {
            PairDecision(PairAction.REPLY, PairNotice.COMMIT, EntryChange.CREATED_REPLIED, true)
        } else {
            PairDecision(PairAction.PROMPT, PairNotice.COMMIT, EntryChange.CREATED_PROMPTED, false)
        }
    }

    /**
     * 3d: the half state (a pinned row that offers Cancel pairing) earns the notice: this device
     * approved and X's approve has not verified ("Waiting for $X"), or a GET fetched after the
     * verify shows approves_me false. Anything else is a plain drop.
     */
    fun isHalfState(pinned: Boolean, approved: Boolean, approveVerified: Boolean, listApprovesMe: Boolean?, listAfterVerify: Boolean): Boolean =
        pinned && ((approved && !approveVerified) || (approveVerified && listAfterVerify && listApprovesMe == false))

    private fun halfOrDrop(i: CommitInput): PairDecision =
        if (isHalfState(i.pinned, i.approved, i.approveVerified, i.listApprovesMe, i.listAfterVerify)) half else drop

    /** N-side hint on a committed row (golden pair_hint). */
    enum class Hint { STILL_HOLDS, NO_REPLY_YET }

    fun hint(approvesMe: Boolean?, committedSeconds: Long): Hint? = when {
        approvesMe == true -> Hint.STILL_HOLDS
        committedSeconds >= 3 * 86_400L -> Hint.NO_REPLY_YET
        else -> null
    }

    /** Timeout at 30 days (golden pair_timeout). */
    enum class Timeout { KEEP_PIN, DROP_PIN, RESEND, KEEP_WAITING, COMPLETE }

    enum class Resend { OFFLINE, LOGGED_OUT, RATE_LIMITED, SERVER_ERROR, OK_C_VERIFIED, OK_OTHER }

    fun timeout(approveVerified: Boolean, approved: Boolean, resend: Resend?): Timeout = when {
        approveVerified -> Timeout.KEEP_PIN
        !approved -> Timeout.DROP_PIN
        resend == null -> Timeout.RESEND
        resend == Resend.OK_C_VERIFIED -> Timeout.COMPLETE
        resend == Resend.OK_OTHER -> Timeout.DROP_PIN
        else -> Timeout.KEEP_WAITING
    }
}
