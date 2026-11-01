package com.pusharmor.app

import com.pusharmor.app.ui.FadeEdges
import com.pusharmor.app.ui.fadeEdges
import com.pusharmor.app.notify.HistoryFilter
import com.pusharmor.app.ui.UiText
import org.junit.Assert.assertEquals
import org.junit.Test

class EdgeFadeTest {
    @Test fun startFadesOnlyTheEnd() = assertEquals(FadeEdges(start = false, end = true), fadeEdges(0, 300))
    @Test fun middleFadesBoth() = assertEquals(FadeEdges(start = true, end = true), fadeEdges(120, 300))
    @Test fun endFadesOnlyTheStart() = assertEquals(FadeEdges(start = true, end = false), fadeEdges(300, 300))
    @Test fun nothingHiddenMeansNoFade() = assertEquals(FadeEdges(start = false, end = false), fadeEdges(0, 0))

    @Test fun historyPeerChipsSortByNameAfterAll() {
        val rows = listOf(HistoryFilter.Row("1", true), HistoryFilter.Row("2", true), HistoryFilter.Row("3", true), HistoryFilter.Row(null, true))
        val names = mapOf("1" to "zeta", "2" to "Alpha", "3" to "beta")
        val chips = HistoryFilter.chips(rows) { names.getValue(it) }
        assertEquals(listOf("All", "Alpha", "beta", "zeta", "Unknown"), chips.map { when (it) { HistoryFilter.Chip.All -> "All"; HistoryFilter.Chip.Unknown -> "Unknown"; is HistoryFilter.Chip.PeerChip -> it.name } })
    }

    @Test fun sortByNameIsCaseInsensitive() =
        assertEquals(listOf("alpha", "Beta", "gamma"), UiText.sortedByName(listOf("gamma", "Beta", "alpha"), { it }))
}
