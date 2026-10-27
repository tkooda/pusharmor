package com.pusharmor.app.notify

/**
 * Lock screen / watch / always-hide choice for a url / text / tel notification (section 6).
 * Effective = main AND peer for the two "show" switches; "Always hide content" is on when the
 * main OR the peer switch is on, and wins over both.
 */
data class Policy(
    /** Title "New message from $peer", no content, locked or unlocked. */
    val hideAll: Boolean,
    /** VISIBILITY_PRIVATE with a public version "New message" and no content. */
    val privateOnLockScreen: Boolean,
    /** setLocalOnly(true): the watch gets nothing. */
    val localOnly: Boolean,
) {
    companion object {
        fun of(mainLock: Boolean, peerLock: Boolean, mainWatch: Boolean, peerWatch: Boolean, mainHide: Boolean, peerHide: Boolean): Policy {
            val hide = mainHide || peerHide
            val lock = mainLock && peerLock
            val watch = mainWatch && peerWatch
            return Policy(hideAll = hide, privateOnLockScreen = !hide && !lock, localOnly = !watch)
        }

        /** Per-peer switches are greyed out while the main switch is off. */
        fun peerSwitchEnabled(main: Boolean) = main
    }
}

/** History filter chips (catalog History filter). */
object HistoryFilter {
    sealed class Chip {
        object All : Chip()
        data class PeerChip(val peerId: String, val name: String) : Chip()
        object Unknown : Chip()
    }

    data class Row(val peerId: String?, val received: Boolean)

    /** All; one chip per verified peer (hidden while rows come from one peer only); Unknown while an Unknown row exists. */
    fun chips(rows: List<Row>, nameOf: (String) -> String): List<Chip> {
        val peers = rows.mapNotNull { it.peerId }.distinct()
        val out = mutableListOf<Chip>(Chip.All)
        if (peers.size > 1) peers.forEach { out += Chip.PeerChip(it, nameOf(it)) }
        if (rows.any { it.peerId == null }) out += Chip.Unknown
        return out
    }

    fun matches(row: Row, chip: Chip): Boolean = when (chip) {
        Chip.All -> true
        is Chip.PeerChip -> row.received && row.peerId == chip.peerId
        Chip.Unknown -> row.peerId == null
    }

    /** The filter resets to All when it has no rows left. */
    fun effective(rows: List<Row>, chip: Chip): Chip = if (chip != Chip.All && rows.none { matches(it, chip) }) Chip.All else chip
}
