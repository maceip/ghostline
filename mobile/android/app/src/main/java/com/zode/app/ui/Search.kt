//
//  Search.kt
//  ZodeMobile (Android)
//
//  Search over the library, the agent tasks and the attachments. Results are
//  grouped by the contract's `kind` values (track, album, artist, playlist,
//  task, file, action).
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
import androidx.compose.runtime.LaunchedEffect
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
import com.zode.app.data.AppView
import com.zode.app.data.PlayableItem
import com.zode.app.data.SearchResult
import com.zode.app.design.LocalMetroPalette
import com.zode.app.design.MetroLabel
import com.zode.app.design.MetroType
import com.zode.app.design.ZodeTokens

@Composable
fun SearchScreen(state: ZodeAppState) {
    val palette = LocalMetroPalette.current
    var query by remember { mutableStateOf("") }

    // A query pushed from outside the app (Spotlight, system search).
    LaunchedEffect(state.router.incomingSearch) {
        val incoming = state.router.incomingSearch
        if (!incoming.isNullOrEmpty()) {
            query = incoming
            state.updateSearch(incoming)
            state.router.incomingSearch = null
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
            MetroLabel("Search", color = palette.textMuted)

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(0.dp))
                    .background(palette.surface)
                    .padding(horizontal = ZodeTokens.Metrics.space3, vertical = ZodeTokens.Metrics.space3),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(text = "⌕", color = palette.textMuted, style = MetroType.body)
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = ZodeTokens.Metrics.space2)
                ) {
                    if (query.isEmpty()) {
                        Text(
                            text = "Tracks, albums, artists, tasks",
                            color = palette.textMuted,
                            style = MetroType.body
                        )
                    }
                    BasicTextField(
                        value = query,
                        onValueChange = {
                            query = it
                            state.updateSearch(it)
                        },
                        textStyle = MetroType.body.copy(color = palette.text),
                        cursorBrush = SolidColor(palette.accent),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            if (state.searchResults.isEmpty()) {
                item {
                    Column(
                        modifier = Modifier.padding(horizontal = ZodeTokens.Metrics.gutter),
                        verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space2)
                    ) {
                        MetroLabel(
                            if (query.isEmpty()) "Type to search" else "Nothing found",
                            color = palette.textMuted
                        )
                        Text(
                            text = "Tracks, albums, artists, playlists, agent tasks and attachments.",
                            color = palette.textMuted,
                            style = MetroType.body
                        )
                    }
                }
            } else {
                state.groupedSearchResults.forEach { (kind, results) ->
                    item(key = "header-${kind.json}") {
                        MetroLabel(
                            text = kind.json,
                            color = palette.textMuted,
                            modifier = Modifier.padding(
                                horizontal = ZodeTokens.Metrics.gutter,
                                vertical = ZodeTokens.Metrics.space2
                            )
                        )
                    }
                    items(items = results, key = { "${kind.json}-${it.id}" }) { result ->
                        ResultRow(state, result)
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
    }
}

@Composable
private fun ResultRow(state: ZodeAppState, result: SearchResult) {
    val palette = LocalMetroPalette.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { open(state, result) }
            .padding(
                horizontal = ZodeTokens.Metrics.gutter,
                vertical = ZodeTokens.Metrics.space3
            ),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = result.title,
                color = palette.text,
                style = MetroType.body,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            result.subtitle?.let { subtitle ->
                Text(
                    text = subtitle,
                    color = palette.textMuted,
                    style = MetroType.micro,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Text(
            text = "›",
            color = palette.textMuted,
            style = MetroType.micro
        )
    }
}

private fun open(state: ZodeAppState, result: SearchResult) {
    state.haptics.play("select")
    when (result.kind) {
        SearchResult.Kind.TRACK -> {
            result.payload["id"]?.let { state.playTrack(it) }
            state.show(AppView.NOW_PLAYING)
        }
        SearchResult.Kind.ALBUM -> {
            result.payload["id"]?.let { state.play(PlayableItem.AlbumItem(it)) }
            state.show(AppView.NOW_PLAYING)
        }
        SearchResult.Kind.ARTIST -> {
            result.payload["id"]?.let { state.play(PlayableItem.ArtistItem(it)) }
            state.show(AppView.NOW_PLAYING)
        }
        SearchResult.Kind.PLAYLIST -> {
            result.payload["id"]?.let { state.play(PlayableItem.PlaylistItem(it)) }
            state.show(AppView.NOW_PLAYING)
        }
        SearchResult.Kind.TASK -> state.show(AppView.AGENT)
        SearchResult.Kind.FILE -> state.show(AppView.AGENT)
        SearchResult.Kind.ACTION -> {
            result.payload["id"]?.let { state.play(PlayableItem.AlbumItem(it)) }
            state.show(AppView.NOW_PLAYING)
        }
    }
}
