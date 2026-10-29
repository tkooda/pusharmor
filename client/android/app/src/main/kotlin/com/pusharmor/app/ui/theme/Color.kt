package com.pusharmor.app.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// Brand constants (both themes).
val BrandNavy = Color(0xFF1F3A5F)
val BrandGreen = Color(0xFF34C77B) // "Push" is always this colour
val OnBrandGreen = Color(0xFF0E2238)
val CtaEdge = Color(0xFF157A4A) // light themes only
val ArmorDark = Color(0xFFF4F7FA)
val BetaFill = Color(0xFFF5B83D)
val OnBeta = Color(0xFF3A2A00)

val LightColors = lightColorScheme(
    primary = Color(0xFF1F3A5F), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD9E5F4), onPrimaryContainer = Color(0xFF0E2238),
    secondary = Color(0xFF1F3A5F), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD9E5F4), onSecondaryContainer = Color(0xFF0E2238),
    tertiary = BrandGreen, onTertiary = OnBrandGreen,
    background = Color(0xFFF2F4F7), onBackground = Color(0xFF131C26),
    surface = Color(0xFFF2F4F7), onSurface = Color(0xFF131C26),
    surfaceVariant = Color(0xFFE9EDF2), onSurfaceVariant = Color(0xFF4A5663),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFF4F7FB),
    surfaceContainer = Color(0xFFE9EDF2), surfaceContainerHigh = Color(0xFFDFE5EC),
    surfaceContainerHighest = Color(0xFFD5DCE4),
    outline = Color(0xFF737F8C), outlineVariant = Color(0xFFE3E8EE),
    error = Color(0xFFB42318), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFCE8E6), onErrorContainer = Color(0xFF5F1209),
)

val DarkColors = darkColorScheme(
    primary = Color(0xFFA9C8F0), onPrimary = Color(0xFF0E2238),
    primaryContainer = Color(0xFF28466E), onPrimaryContainer = Color(0xFFD9E5F4),
    secondary = Color(0xFFA9C8F0), onSecondary = Color(0xFF0E2238),
    secondaryContainer = Color(0xFF28466E), onSecondaryContainer = Color(0xFFD9E5F4),
    tertiary = BrandGreen, onTertiary = OnBrandGreen,
    background = Color(0xFF0B1119), onBackground = Color(0xFFE8EDF3),
    surface = Color(0xFF0B1119), onSurface = Color(0xFFE8EDF3),
    surfaceVariant = Color(0xFF1F2A38), onSurfaceVariant = Color(0xFFA7B3C0),
    surfaceContainerLowest = Color(0xFF080D13), surfaceContainerLow = Color(0xFF161F2B),
    surfaceContainer = Color(0xFF1F2A38), surfaceContainerHigh = Color(0xFF283545),
    surfaceContainerHighest = Color(0xFF303E50),
    outline = Color(0xFF8794A3), outlineVariant = Color(0xFF232F3D),
    error = Color(0xFFFF8A80), onError = Color(0xFF4A1A16),
    errorContainer = Color(0xFF4A1A16), onErrorContainer = Color(0xFFFFDAD5),
)

/** Roles that ColorScheme does not have. */
@Immutable
data class PaExtra(
    val dark: Boolean,
    val success: Color, val armor: Color,
    val tile: Color, val expandedRow: Color,
    val iconTileBg: Color, val iconTileFg: Color,
    val hero: Color, val heroBorder: Color, val onHero: Color, val onHero2: Color, val heroIconBg: Color,
    val plate: Color, val fpCell: Color, val pairBorder: Color,
    val illoHalo: Color, val illoRing: Color, val ctaEdge: Color, val tileEdge: Color,
)

val LightExtra = PaExtra(
    dark = false,
    success = Color(0xFF157A4A), armor = BrandNavy,
    tile = Color(0xFFFFFFFF), expandedRow = Color(0xFFF4F7FB),
    iconTileBg = Color(0xFFE6EDF6), iconTileFg = Color(0xFF1F3A5F),
    hero = Color(0xFF1F3A5F), heroBorder = Color.Transparent, onHero = Color(0xFFFFFFFF),
    onHero2 = Color(0xFFC4D3E6), heroIconBg = Color(0xFF2B4A75),
    plate = Color(0xFFEEF3FA), fpCell = Color(0xFFFFFFFF),
    pairBorder = Color(0xFFD5DFEB), illoHalo = Color(0xFFE3ECF7), illoRing = Color(0xFFD5DEE9),
    ctaEdge = CtaEdge, tileEdge = Color.Transparent,
)

val DarkExtra = PaExtra(
    dark = true,
    success = Color(0xFF5FD89A), armor = ArmorDark,
    tile = Color(0xFF161F2B), expandedRow = Color(0xFF1B2533),
    iconTileBg = Color(0xFF22354F), iconTileFg = Color(0xFFA9C8F0),
    hero = Color(0xFF1B3150), heroBorder = Color(0xFF2B4770), onHero = Color(0xFFF4F7FA),
    onHero2 = Color(0xFFB8C8DC), heroIconBg = Color(0xFF284468),
    plate = Color(0xFF101C2D), fpCell = Color(0xFF0B1422),
    pairBorder = Color(0xFF2B3A4E), illoHalo = Color(0xFF13233A), illoRing = Color(0xFF24344A),
    ctaEdge = Color.Transparent, // dark: the fill alone is >= 7.59:1 on page and tile
    tileEdge = Color(0xFF4A6D9E), // sign-in tile edge over the halo, dark only
)

val LocalPaExtra = staticCompositionLocalOf { LightExtra }
