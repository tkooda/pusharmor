package com.pusharmor.protocol

/**
 * Per-sender anti-replay window (catalog Replay window): highest accepted n (h) and a 100-bit
 * bitmap; bit k marks n = h - k as seen. Immutable; [accept] returns the new state.
 */
class ReplayWindow private constructor(val h: Long, private val bits: java.util.BitSet) {
    enum class Verdict { FRESH, SEEN, TOO_OLD }

    fun check(n: Long): Verdict {
        require(n in 1..MAX_COUNTER)
        if (n > h) return Verdict.FRESH
        if (n <= h - SIZE) return Verdict.TOO_OLD
        return if (bits.get((h - n).toInt())) Verdict.SEEN else Verdict.FRESH
    }

    /** New state after accepting [n]; only valid when [check] returned FRESH. */
    fun accept(n: Long): ReplayWindow {
        check(check(n) == Verdict.FRESH)
        return if (n > h) {
            val shift = n - h
            val nb = java.util.BitSet(SIZE)
            if (shift < SIZE) {
                for (k in 0 until SIZE - shift.toInt()) if (bits.get(k)) nb.set(k + shift.toInt())
            }
            nb.set(0)
            ReplayWindow(n, nb)
        } else {
            val nb = bits.clone() as java.util.BitSet
            nb.set((h - n).toInt())
            ReplayWindow(h, nb)
        }
    }

    /** 13-byte BLOB, bit k in byte k / 8 at bit position k % 8. */
    fun bitmapBytes(): ByteArray {
        val out = ByteArray(13)
        for (k in 0 until SIZE) if (bits.get(k)) out[k / 8] = (out[k / 8].toInt() or (1 shl (k % 8))).toByte()
        return out
    }

    companion object {
        const val SIZE = 100

        /** Fresh state created when a pairing pins the sender: h = 0, clear bitmap. */
        fun fresh() = ReplayWindow(0, java.util.BitSet(SIZE))

        fun of(h: Long, bitmap: ByteArray): ReplayWindow {
            require(bitmap.size == 13)
            val b = java.util.BitSet(SIZE)
            for (k in 0 until SIZE) if ((bitmap[k / 8].toInt() shr (k % 8)) and 1 == 1) b.set(k)
            return ReplayWindow(h, b)
        }
    }
}
