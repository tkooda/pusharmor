package com.pusharmor.app

import com.pusharmor.app.ui.balancedPerRow
import org.junit.Assert.assertEquals
import org.junit.Test

/** Wrapped History action buttons fill their rows evenly, so a large font never leaves "Save" alone on a row. */
class ButtonRowBalanceTest {
    @Test fun fourButtonsAtThreePerRowGoTwoAndTwo() = assertEquals(2, balancedPerRow(4, 3))
    @Test fun allFitStaysOneRow() = assertEquals(4, balancedPerRow(4, 4))
    @Test fun oneFitsStacksAll() = assertEquals(1, balancedPerRow(4, 1))
    @Test fun fiveAtThreeGoThreeAndTwo() = assertEquals(3, balancedPerRow(5, 3))
    @Test fun emptyIsSafe() = assertEquals(1, balancedPerRow(0, 3))
}
