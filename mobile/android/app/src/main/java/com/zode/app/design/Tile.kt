//
//  Tile.kt
//  ZodeMobile (Android)
//
//  Metro's building blocks: big flat squares with zero corner radius, flat
//  fills, uppercase tracked labels and no chrome whatsoever.
//

package com.zode.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * A flat, square-cornered tile. Metro never rounds its tiles, so the
 * [RoundedCornerShape] is always zero.
 */
@Composable
fun MetroTile(
    fill: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(0.dp))
            .background(fill)
    ) {
        content()
    }
}

/** The uppercase, letter-spaced Metro label. */
@Composable
fun MetroLabel(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MetroPalette.of(AppTheme.INK).textMuted,
    style: androidx.compose.ui.text.TextStyle = MetroType.label
) {
    Text(
        text = text.uppercase(),
        modifier = modifier,
        color = color,
        style = style,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}

/**
 * Flat album art: a solid accent square with the Zune bracket mark and the
 * album name.
 */
@Composable
fun MetroArtwork(
    accent: Color,
    caption: String,
    size: androidx.compose.ui.unit.Dp,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .then(if (size > 0.dp) Modifier.size(size) else Modifier)
            .clip(RoundedCornerShape(0.dp))
            .background(accent)
    ) {
        Row(
            modifier = Modifier.align(Alignment.Center),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(size * 0.06f)
        ) {
            BracketMark(size * 0.16f, flipped = false)
            Box(
                modifier = Modifier
                    .size(size * 0.035f)
                    .clip(RoundedCornerShape(0.dp))
                    .background(Color.Black.copy(alpha = 0.75f))
            )
            BracketMark(size * 0.16f, flipped = true)
        }
        Text(
            text = caption.uppercase(),
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(size * 0.06f),
            color = Color.Black.copy(alpha = 0.8f),
            style = MetroType.micro
        )
    }
}

/** One half of the Zune bracket mark. */
@Composable
private fun BracketMark(height: androidx.compose.ui.unit.Dp, flipped: Boolean) {
    val thickness = height * 0.22f
    Box(
        modifier = Modifier
            .width(thickness * 2.4f)
            .height(height),
        contentAlignment = if (flipped) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Box(
            modifier = Modifier
                .width(thickness)
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.75f))
        )
        Box(
            modifier = Modifier
                .align(if (flipped) Alignment.TopStart else Alignment.BottomStart)
                .width(thickness * 2.4f)
                .height(thickness)
                .background(Color.Black.copy(alpha = 0.75f))
        )
    }
}

/** The chunky, square-cornered progress bar used by the scrubber. */
@Composable
fun MetroProgressBar(
    progress: Float,
    track: Color,
    fill: Color,
    modifier: Modifier = Modifier,
    height: androidx.compose.ui.unit.Dp = 10.dp
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(0.dp))
            .background(track)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(progress.coerceIn(0f, 1f))
                .fillMaxHeight()
                .clip(RoundedCornerShape(0.dp))
                .background(fill)
        )
    }
}

/** The Metro "working" indicator: a stack of flat blocks that pulse. */
@Composable
fun MetroWorkingIndicator(
    phase: Double,
    color: Color,
    inactive: Color,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        repeat(3) { index ->
            Box(
                modifier = Modifier
                    .width(10.dp)
                    .height(22.dp)
                    .clip(RoundedCornerShape(0.dp))
                    .background(if (index == 0) color else inactive)
                    .then(
                        if (index == 0) {
                            Modifier.graphicsLayer { alpha = 0.35f + 0.65f * phase.toFloat() }
                        } else {
                            Modifier
                        }
                    )
            )
        }
    }
}
