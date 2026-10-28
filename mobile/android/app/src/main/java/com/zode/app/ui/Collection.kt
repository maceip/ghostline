//
//  Collection.kt
//  ZodeMobile (Android)
//
//  Metro's horizontal carousel: big flat square album tiles that scroll
//  sideways, with uppercase tracked section headers.
//

package com.zode.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zode.app.ZodeAppState
import com.zode.app.data.Album
import com.zode.app.data.Playlist
import com.zode.app.design.LocalMetroPalette
import com.zode.app.design.MetroArtwork
import com.zode.app.design.MetroLabel
import com.zode.app.design.MetroType
import com.zode.app.design.ZodeTokens

private val TILE_SIZE = 156.dp

@Composable
fun CollectionScreen(state: ZodeAppState) {
    val palette = LocalMetroPalette.current

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(top = ZodeTokens.Metrics.space6, bottom = ZodeTokens.Metrics.space8),
        verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space8)
    ) {
        AlbumSection(state)
        PlaylistSection(state)
        ArtistSection(state)
    }
}

@Composable
private fun SectionHeader(title: String, trailing: String) {
    val palette = LocalMetroPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = ZodeTokens.Metrics.gutter),
        verticalAlignment = Alignment.Bottom
    ) {
        MetroLabel(title, color = palette.textMuted)
        Box(modifier = Modifier.weight(1f))
        Text(
            text = trailing,
            color = palette.textMuted,
            style = MetroType.micro
        )
    }
}

@Composable
private fun AlbumSection(state: ZodeAppState) {
    val palette = LocalMetroPalette.current

    Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space4)) {
        SectionHeader("Albums", "${state.library.albums.size}")

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = ZodeTokens.Metrics.gutter),
            horizontalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space4)
        ) {
            state.library.albums.forEach { album ->
                AlbumTile(state, album)
            }
        }
    }
}

@Composable
private fun AlbumTile(state: ZodeAppState, album: Album) {
    val palette = LocalMetroPalette.current

    Column(
        modifier = Modifier
            .width(TILE_SIZE)
            .clickable {
                state.play(com.zode.app.data.PlayableItem.AlbumItem(album.id))
                state.show(com.zode.app.data.AppView.NOW_PLAYING)
            }
    ) {
        MetroArtwork(
            accent = Color(album.accent),
            caption = album.title,
            size = TILE_SIZE
        )
        Text(
            text = album.title,
            color = palette.text,
            style = MetroType.body,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = ZodeTokens.Metrics.space2)
        )
        Text(
            text = state.library.artist(album.artistID)?.name ?: "",
            color = palette.textMuted,
            style = MetroType.micro,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun PlaylistSection(state: ZodeAppState) {
    val palette = LocalMetroPalette.current

    Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space4)) {
        SectionHeader("Playlists", "${state.library.playlists.size}")

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = ZodeTokens.Metrics.gutter),
            horizontalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space4)
        ) {
            state.library.playlists.forEach { playlist ->
                PlaylistTile(state, playlist)
            }
        }
    }
}

@Composable
private fun PlaylistTile(state: ZodeAppState, playlist: Playlist) {
    val palette = LocalMetroPalette.current

    Column(
        modifier = Modifier
            .width(TILE_SIZE)
            .clickable {
                state.play(com.zode.app.data.PlayableItem.PlaylistItem(playlist.id))
                state.show(com.zode.app.data.AppView.NOW_PLAYING)
            }
    ) {
        Box(
            modifier = Modifier
                .width(TILE_SIZE)
                .height(TILE_SIZE)
                .clip(RoundedCornerShape(0.dp))
                .background(palette.accent)
        ) {
            Text(
                text = "${playlist.trackIDs.size}",
                color = palette.onAccent,
                style = MetroType.display.copy(fontSize = MetroType.display.fontSize * 0.9f),
                modifier = Modifier.padding(ZodeTokens.Metrics.space3)
            )
        }
        Text(
            text = playlist.title,
            color = palette.text,
            style = MetroType.body,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = ZodeTokens.Metrics.space2)
        )
        Text(
            text = playlist.subtitle,
            color = palette.textMuted,
            style = MetroType.micro,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun ArtistSection(state: ZodeAppState) {
    val palette = LocalMetroPalette.current

    Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space3)) {
        SectionHeader("Artists", "${state.library.artists.size}")

        state.library.artists.forEach { artist ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        state.play(com.zode.app.data.PlayableItem.ArtistItem(artist.id))
                        state.show(com.zode.app.data.AppView.NOW_PLAYING)
                    }
                    .padding(
                        horizontal = ZodeTokens.Metrics.gutter,
                        vertical = ZodeTokens.Metrics.space4
                    ),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = artist.name,
                    color = palette.text,
                    style = MetroType.subtitle,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Box(modifier = Modifier.weight(1f))
                Text(
                    text = artist.genre.uppercase(),
                    color = palette.textMuted,
                    style = MetroType.micro
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(palette.hairline)
                    .padding(horizontal = ZodeTokens.Metrics.gutter)
            )
        }
    }
}
