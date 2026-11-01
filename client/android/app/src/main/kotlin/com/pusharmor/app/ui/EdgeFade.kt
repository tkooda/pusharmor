package com.pusharmor.app.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Which sides of a sideways-scrolling row hide content: [start] when scrolled past the start, [end] when more lies past the end (I630). */
internal data class FadeEdges(val start: Boolean, val end: Boolean)

/** Edge state from a scroll offset and its maximum: both false when everything fits. */
internal fun fadeEdges(value: Int, max: Int): FadeEdges = FadeEdges(start = value > 0, end = value < max)

/** Fades the start and end edges of a sideways-scrolling row, only where content is hidden. Put it before horizontalScroll. */
internal fun Modifier.edgeFade(state: ScrollState, width: Dp = 24.dp): Modifier =
    graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen).drawWithContent {
        drawContent()
        val e = fadeEdges(state.value, state.maxValue)
        val w = width.toPx().coerceAtMost(size.width / 2)
        // Keep the mask's right and left sides in step with the layout direction.
        val rtl = layoutDirection == androidx.compose.ui.unit.LayoutDirection.Rtl
        val left = if (rtl) e.end else e.start
        val right = if (rtl) e.start else e.end
        if (left) drawRect(Brush.horizontalGradient(listOf(Color.Transparent, Color.Black), 0f, w), Offset.Zero, Size(w, size.height), blendMode = BlendMode.DstIn)
        if (right) drawRect(Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), size.width - w, size.width), Offset(size.width - w, 0f), Size(w, size.height), blendMode = BlendMode.DstIn)
    }
