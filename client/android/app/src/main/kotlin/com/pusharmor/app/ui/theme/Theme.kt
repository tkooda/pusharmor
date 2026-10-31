package com.pusharmor.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val base = Typography()

/** Material 3 defaults (Roboto) with the PushArmor overrides. */
val PaTypography = base.copy(
    headlineSmall = base.headlineSmall.copy(fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleLarge = base.titleLarge.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = base.titleMedium.copy(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    titleSmall = base.titleSmall.copy(fontWeight = FontWeight.Medium),
    labelMedium = base.labelMedium.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.8.sp),
)

/** Pairing fingerprint and code cells. */
val FingerprintText = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 40.sp, lineHeight = 48.sp)

/** Brand theme; no dynamic color, so the brand looks the same on every device. */
@Composable
fun PushArmorTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalPaExtra provides if (dark) DarkExtra else LightExtra) {
        MaterialTheme(colorScheme = if (dark) DarkColors else LightColors, typography = PaTypography, content = content)
    }
}
