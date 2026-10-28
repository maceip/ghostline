//
//  Library.kt
//  ZodeMobile (Android)
//
//  A dense, Metro-style list: index number on the left, title and artist in
//  the middle, duration on the right. No rows are rounded and there is no
//  chrome beyond a hairline.
//

package com.zode.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zode.app.ZodeAppState
import com.zode.app.data.Track
import com.zode.app.design.LocalMetroPalette
import com.zode.app.design.MetroLabel
import com.zode.app.design.MetroType
import com.zode.app.design.ZodeTokens

@Composable
fun LibraryScreen(state: ZodeAppState) {
    val palette = LocalMetroPalette.current
    var filter by remember { mutableStateOf("") }

    val needle = filter.trim().lowercase()
    val tracks = if (needle.isEmpty()) {
        state.library.tracks
    } else {
        state.library.tracks.filter { track ->
            val artist = state.library.artist(track.artistID)?.name?.lowercase() ?: ""
            track.title.lowercase().contains(needle) || artist.contains(needle)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.padding(
                horizontal = ZodeTokens.Metrics.gutter,
                vertical = ZodeTokens.Metrics.space4
            ),
            verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space3)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                MetroLabel("Library", color = palette.textMuted)
                Box(modifier = Modifier.weight(1f))
                Text(
                    text = "${tracks.size} TRACKS",
                    color = palette.textMuted,
                    style = MetroType.micro
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(0.dp))
                    .background(palette.surface)
                    .padding(horizontal = ZodeTokens.Metrics.space3, vertical = ZodeTokens.Metrics.space3),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "⌕",
                    color = palette.textMuted,
                    style = MetroType.body
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = ZodeTokens.Metrics.space2)
                ) {
                    if (filter.isEmpty()) {
                        Text(
                            text = "Filter",
                            color = palette.textMuted,
                            style = MetroType.body
                        )
                    }
                    BasicTextField(
                        value = filter,
                        onValueChange = { filter = it },
                        textStyle = MetroType.body.copy(color = palette.text),
                        cursorBrush = SolidColor(palette.accent),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(items = tracks, key = { it.id }) { track ->
                LibraryRow(state, track)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(palette.hairline)
                )
            }
        }
    }
}

@Composable
private fun LibraryRow(state: ZodeAppState, track: Track) {
    val palette = LocalMetroPalette.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                state.playTrack(track.id)
                state.show(com.zode.app.data.AppView.NOW_PLAYING)
            }
            .padding(
                horizontal = ZodeTokens.Metrics.gutter,
                vertical = ZodeTokens.Metrics.space3
            ),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "%02d".format(track.trackNumber),
            color = palette.textMuted,
            style = MetroType.micro,
            modifier = Modifier.padding(end = ZodeTokens.Metrics.space4)
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = track.title,
                color = palette.text,
                style = MetroType.body,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = state.library.artist(track.artistID)?.name ?: "",
                color = palette.textMuted,
                style = MetroType.micro,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Text(
            text = track.durationLabel,
            color = palette.textMuted,
            style = MetroType.micro
        )
    }
}
