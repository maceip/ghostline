//
//  NowPlaying.kt
//  ZodeMobile (Android)
//
//  Metro's Now Playing: an oversized square tile, a light-weight display
//  title, a chunky square-cornered scrubber and big transport glyphs.
//

package com.zode.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.zode.app.ZodeAppState
import com.zode.app.design.LocalMetroPalette
import com.zode.app.design.MetroArtwork
import com.zode.app.design.MetroLabel
import com.zode.app.design.MetroType
import com.zode.app.design.ZodeTokens
import kotlin.math.max

@Composable
fun NowPlayingScreen(state: ZodeAppState) {
    val palette = LocalMetroPalette.current
    val track = state.currentTrack
    val album = state.currentAlbum
    val artist = state.currentArtist

    val accent = album?.let { Color(it.accent) } ?: palette.accent
    val caption = album?.title ?: "Zode"

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ZodeTokens.Metrics.gutter)
            .padding(top = ZodeTokens.Metrics.space6, bottom = ZodeTokens.Metrics.space8),
        verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space6)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MetroLabel("Now Playing", color = palette.textMuted)
            Box(modifier = Modifier.weight(1f))
            Text(
                text = state.theme.label,
                color = palette.accent,
                style = MetroType.micro,
                modifier = Modifier
                    .clip(RoundedCornerShape(0.dp))
                    .background(palette.accentGhost)
                    .padding(horizontal = ZodeTokens.Metrics.space3, vertical = ZodeTokens.Metrics.space2)
                    .clickable { state.toggleTheme() }
            )
        }

        MetroArtwork(
            accent = accent,
            caption = caption,
            size = 0.dp,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
        )

        Column {
            Text(
                text = track?.title ?: "Nothing playing",
                color = palette.text,
                style = MetroType.display.copy(fontSize = MetroType.display.fontSize * 0.86f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = artist?.name ?: "Pick something in the Library",
                color = palette.textMuted,
                style = MetroType.subtitle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        Scrubber(state)

        Transport(state)
    }
}

@Composable
private fun Scrubber(state: ZodeAppState) {
    val palette = LocalMetroPalette.current
    val track = state.currentTrack
    val fraction = if (track != null && track.durationSeconds > 0) {
        (state.playback.elapsed / track.durationSeconds).coerceIn(0.0, 1.0).toFloat()
    } else {
        0f
    }

    var dragFraction by remember { mutableFloatStateOf(fraction) }

    Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space2)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(14.dp)
                .clip(RoundedCornerShape(0.dp))
                .background(palette.surfaceAlt)
                .pointerInput(track) {
                    detectHorizontalDragGestures(
                        onDragStart = { offset ->
                            val ratio = (offset.x / size.width).coerceIn(0f, 1f)
                            dragFraction = ratio
                            state.scrub(ratio)
                        }
                    ) { change, _ ->
                        val ratio = (change.position.x / size.width).coerceIn(0f, 1f)
                        dragFraction = ratio
                        state.scrub(ratio)
                    }
                }
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(fraction)
                    .height(14.dp)
                    .background(palette.accent)
            ) {
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .size(14.dp)
                        .background(palette.accentBright)
                )
            }
        }

        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = format(state.playback.elapsed),
                color = palette.textMuted,
                style = MetroType.micro
            )
            Box(modifier = Modifier.weight(1f))
            val duration = (track?.durationSeconds ?: 0).toDouble()
            Text(
                text = "-" + format(max(duration - state.playback.elapsed, 0.0)),
                color = palette.textMuted,
                style = MetroType.micro
            )
        }
    }
}

@Composable
private fun Transport(state: ZodeAppState) {
    val palette = LocalMetroPalette.current

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically
    ) {
        TransportButton(
            glyph = "◀◀",
            size = 60,
            color = palette.text,
            onClick = { state.previous() }
        )
        TransportButton(
            glyph = if (state.playback.isPlaying) "❚❚" else "▶",
            size = 76,
            color = palette.onAccent,
            background = palette.accent,
            onClick = { state.togglePlayback() }
        )
        TransportButton(
            glyph = "▶▶",
            size = 60,
            color = palette.text,
            onClick = { state.next() }
        )
    }
}

@Composable
private fun TransportButton(
    glyph: String,
    size: Int,
    color: Color,
    background: Color? = null,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(RoundedCornerShape(0.dp))
            .background(background ?: Color.Transparent)
            .clickable { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = glyph,
            color = color,
            style = MetroType.title.copy(fontSize = MetroType.title.fontSize * (size / 44f))
        )
    }
}

private fun format(seconds: Double): String {
    val total = Math.round(seconds).toInt()
    return "%d:%02d".format(total / 60, total % 60)
}
