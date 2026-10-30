package com.pusharmor.app.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pusharmor.app.R
import com.pusharmor.app.ui.UiText

/** App icon tile: the launcher foreground on a navy rounded square. Decorative. */
@Composable
fun BrandTile(size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(size * 0.22f)).background(BrandNavy)) {
        Image(painterResource(R.drawable.ic_launcher_foreground), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    }
}

/** "Push" in brand green, "Armor" in the theme armor colour; read as "PushArmor". */
@Composable
fun Wordmark(fontSize: TextUnit, modifier: Modifier = Modifier) {
    val armor = LocalPaExtra.current.armor
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = BrandGreen)) { append("Push") }
            withStyle(SpanStyle(color = armor)) { append("Armor") }
        },
        modifier.semantics { contentDescription = "PushArmor" },
        fontSize = fontSize, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp,
    )
}

/** The one green call to action of a screen; 1 dp dark green edge in light themes. */
@Composable
fun GreenButton(onClick: () -> Unit, text: String, icon: ImageVector?, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val edge = LocalPaExtra.current.ctaEdge
    Button(
        onClick, modifier.heightIn(min = 48.dp), enabled = enabled, shape = CircleShape,
        colors = ButtonDefaults.buttonColors(containerColor = BrandGreen, contentColor = OnBrandGreen),
        border = if (enabled && edge != Color.Transparent) BorderStroke(1.dp, edge) else null,
    ) {
        if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

/** Rounded-square tile behind a leading row icon. */
@Composable
fun IconTile(icon: ImageVector, modifier: Modifier = Modifier, size: Dp = 40.dp, dim: Boolean = false) {
    val x = LocalPaExtra.current
    Box(modifier.size(size).alpha(if (dim) 0.5f else 1f).clip(RoundedCornerShape(12.dp)).background(x.iconTileBg), Alignment.Center) {
        Icon(icon, null, tint = x.iconTileFg, modifier = Modifier.size(24.dp))
    }
}

/** Corner shape of item [index] of [count] in a group: 20 dp at the group ends, 4 dp between. */
fun groupShape(index: Int, count: Int): RoundedCornerShape {
    val top = if (index == 0) 20.dp else 4.dp
    val bottom = if (index == count - 1) 20.dp else 4.dp
    return RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
}

/** Modifier for one item of a group: side margin, shape and tile fill. */
@Composable
fun Modifier.groupItem(index: Int, count: Int, fill: Color = LocalPaExtra.current.tile): Modifier =
    LocalPaExtra.current.cardEdge.let { edge ->
        this.padding(horizontal = 16.dp).fillMaxWidth().clip(groupShape(index, count)).background(fill).border(1.dp, edge, groupShape(index, count))
    }

/** A column of grouped tiles with 2 dp gaps. */
@Composable
fun GroupedList(items: List<@Composable (Modifier) -> Unit>) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        items.forEachIndexed { i, item -> item(Modifier.groupItem(i, items.size)) }
    }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(start = 32.dp, end = 16.dp, top = 20.dp, bottom = 8.dp).semantics { heading() },
        style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}

/** Small top app bar on the page colour; the Scaffold already applied the status bar inset. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaTopBar(title: String, navigationIcon: @Composable () -> Unit = {}, actions: @Composable () -> Unit = {}) {
    // Light: white like the cards (and the status bar strip), so a system heads-up reads against the page.
    val x = LocalPaExtra.current
    val bg = if (x.dark) MaterialTheme.colorScheme.background else x.tile
    TopAppBar(
        title = { Text(title, style = MaterialTheme.typography.headlineSmall) },
        navigationIcon = navigationIcon,
        actions = { actions() },
        windowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        colors = TopAppBarDefaults.topAppBarColors(containerColor = bg, scrolledContainerColor = bg),
    )
}

/** Status mark (10 dp): filled dot, ring, or ring with a bar. Always shown next to its word. */
@Composable
fun StatusMark(kind: UiText.Mark, color: Color) {
    Canvas(Modifier.size(10.dp)) {
        val r = size.minDimension / 2
        val w = 1.6.dp.toPx()
        when (kind) {
            UiText.Mark.OK -> drawCircle(color, r * 0.9f)
            UiText.Mark.WAIT -> drawCircle(color, r - w / 2, style = Stroke(w))
            UiText.Mark.OFF -> {
                drawCircle(color, r - w / 2, style = Stroke(w))
                drawLine(color, Offset(size.width * 0.24f, center.y), Offset(size.width * 0.76f, center.y), w)
            }
        }
    }
}

/** Status mark plus its word, in one colour; read as the word. */
@Composable
fun StatusLine(kind: UiText.Mark, word: String) {
    val color = if (kind == UiText.Mark.OK) LocalPaExtra.current.success else MaterialTheme.colorScheme.onSurfaceVariant
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StatusMark(kind, color)
        Text(word, style = MaterialTheme.typography.bodyMedium, color = color)
    }
}

/** One line, cut in the middle so the start and the end stay; the screen reader gets the full text. */
@Composable
fun MiddleEllipsisText(text: String, style: TextStyle, modifier: Modifier = Modifier) {
    val m = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val max = constraints.maxWidth
        val shown = remember(text, max, style) {
            UiText.middleEllipsis(text) { s -> m.measure(s, style, maxLines = 1, softWrap = false).size.width <= max }
        }
        Text(shown, style = style, maxLines = 1, softWrap = false, modifier = Modifier.semantics { contentDescription = text })
    }
}

/** Empty state: illustration, title, body and an optional action. */
@Composable
fun EmptyState(illustration: @Composable () -> Unit, title: String, body: String, top: Dp, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(start = 40.dp, end = 40.dp, top = top, bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        illustration()
        Spacer(Modifier.height(20.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(body, Modifier.widthIn(max = 300.dp), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (action != null) { Spacer(Modifier.height(24.dp)); action() }
    }
}

/** Blocking state: icon tile, text and actions (no illustration). */
@Composable
fun BlockingState(icon: ImageVector, text: String, modifier: Modifier = Modifier, actions: @Composable () -> Unit) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        IconTile(icon, size = 56.dp)
        Spacer(Modifier.height(20.dp))
        Text(text, Modifier.widthIn(max = 320.dp), style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        Spacer(Modifier.height(24.dp))
        actions()
    }
}

private fun DrawScope.unit() = size.minDimension / 200f

/** Devices illustration: halo, dashed orbit, three device satellites, brand tile in the centre. Decorative. */
@Composable
fun DevicesIllustration() {
    val x = LocalPaExtra.current
    val icons = listOf(rememberVectorPainter(PaIcons.Smartphone), rememberVectorPainter(PaIcons.Laptop), rememberVectorPainter(PaIcons.Tablet))
    Box(Modifier.size(200.dp), Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val u = unit()
            val c = Offset(100 * u, 100 * u)
            val s = 1.5f * u
            drawCircle(x.illoHalo, 60 * u, c)
            drawCircle(x.illoRing, 60 * u, c, style = Stroke(s))
            drawCircle(x.illoRing, 88 * u, c, style = Stroke(s, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * u, 7 * u))))
            val sats = listOf(Offset(100f, 12f), Offset(176f, 144f), Offset(24f, 144f))
            sats.forEachIndexed { i, p ->
                val pc = Offset(p.x * u, p.y * u)
                drawCircle(x.tile, 19 * u, pc)
                drawCircle(x.illoRing, 19 * u, pc, style = Stroke(s))
                val g = 18 * u
                translate(pc.x - g / 2, pc.y - g / 2) {
                    with(icons[i]) { draw(Size(g, g), colorFilter = ColorFilter.tint(x.iconTileFg)) }
                }
            }
        }
        BrandTile(56.dp)
    }
}

/** Messages illustration: halo, stacked message cards, a link chip. Decorative. */
@Composable
fun MessagesIllustration() {
    val x = LocalPaExtra.current
    val bar = MaterialTheme.colorScheme.surfaceContainerHigh
    val link = rememberVectorPainter(PaIcons.Link)
    Canvas(Modifier.size(200.dp, 170.dp)) {
        val u = size.width / 200f
        val s = 1.5f * u
        drawCircle(x.illoHalo, 74 * u, Offset(100 * u, 88 * u))
        fun card(l: Float, t: Float, w: Float, h: Float, r: Float, a: Float) {
            drawRoundRect(x.tile, Offset(l * u, t * u), Size(w * u, h * u), CornerRadius(r * u), alpha = a)
            drawRoundRect(x.illoRing, Offset(l * u, t * u), Size(w * u, h * u), CornerRadius(r * u), style = Stroke(s), alpha = a)
        }
        card(52f, 26f, 96f, 40f, 10f, 0.55f)
        card(40f, 48f, 120f, 46f, 12f, 0.8f)
        card(26f, 76f, 148f, 62f, 14f, 1f)
        drawRoundRect(x.iconTileBg, Offset(40 * u, 91 * u), Size(32 * u, 32 * u), CornerRadius(9 * u))
        translate(46 * u, 97 * u) { with(link) { draw(Size(20 * u, 20 * u), colorFilter = ColorFilter.tint(x.iconTileFg)) } }
        drawRoundRect(bar, Offset(82 * u, 96 * u), Size(76 * u, 8 * u), CornerRadius(4 * u))
        drawRoundRect(bar, Offset(82 * u, 111 * u), Size(50 * u, 8 * u), CornerRadius(4 * u))
    }
}

/** Sign-in halo with the 88 dp brand tile (edge in dark only). Decorative. */
@Composable
fun SignInHalo() {
    val x = LocalPaExtra.current
    Box(Modifier.fillMaxWidth().height(185.dp), Alignment.Center) {
        Canvas(Modifier.size(185.dp)) {
            val r = 84.dp.toPx()
            drawCircle(x.illoHalo, r)
            drawCircle(x.illoRing, r, style = Stroke(1.5.dp.toPx()))
        }
        BrandTile(88.dp, Modifier.border(1.dp, x.tileEdge, RoundedCornerShape(19.dp)))
    }
}
