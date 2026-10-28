//
//  Library.kt
//  ZodeMobile (Android)
//
//  The canonical library.
//
//  The web app owns the records: `packages/shared/library.json` is generated
//  from `apps/web/src/data/library.js` by `scripts/dump_library.mjs`, and the
//  copy in `res/raw` is byte-identical to it. The iOS app reads the same
//  file from its bundle, so every platform presents exactly the same records
//  -- no second, drifting catalogue.
//
//  `tools/verify_android.py` and `tools/verify_swift.py` assert that the two
//  bundled copies still match the shared file.
//

package com.zode.app.data

import android.content.Context
import com.zode.app.R
import org.json.JSONArray
import org.json.JSONObject

/** The whole library, indexed for fast lookups. */
class Library(
    val artists: List<Artist>,
    val albums: List<Album>,
    val tracks: List<Track>,
    val playlists: List<Playlist>
) {
    private val artistIndex = artists.associateBy { it.id }
    private val albumIndex = albums.associateBy { it.id }
    private val trackIndex = tracks.associateBy { it.id }
    private val playlistIndex = playlists.associateBy { it.id }

    fun artist(id: String): Artist? = artistIndex[id]
    fun album(id: String): Album? = albumIndex[id]
    fun track(id: String): Track? = trackIndex[id]
    fun playlist(id: String): Playlist? = playlistIndex[id]

    fun tracksInAlbum(albumID: String): List<Track> =
        albumIndex[albumID]?.trackIDs?.mapNotNull { trackIndex[it] } ?: emptyList()

    fun tracksByArtist(artistID: String): List<Track> =
        tracks.filter { it.artistID == artistID }

    fun tracksInPlaylist(playlistID: String): List<Track> =
        playlistIndex[playlistID]?.trackIDs?.mapNotNull { trackIndex[it] } ?: emptyList()

    /** Every track of a playable item, in order. */
    fun tracksOf(item: PlayableItem): List<Track> = when (item) {
        is PlayableItem.TrackItem -> listOfNotNull(track(item.id))
        is PlayableItem.AlbumItem -> tracksInAlbum(item.id)
        is PlayableItem.ArtistItem -> tracksByArtist(item.id)
        is PlayableItem.PlaylistItem -> tracksInPlaylist(item.id)
    }

    /**
     * Filters the library. The `kind` mirrors the contract's
     * `SearchResult.kind`.
     */
    fun search(query: String): List<SearchResult> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return emptyList()

        val results = mutableListOf<SearchResult>()

        for (track in tracks) {
            val artist = artistIndex[track.artistID]?.name ?: ""
            if (track.title.lowercase().contains(needle) ||
                artist.lowercase().contains(needle) ||
                track.albumID.lowercase().contains(needle)
            ) {
                results += SearchResult(
                    id = track.id,
                    title = track.title,
                    subtitle = "$artist — ${track.durationLabel}",
                    kind = SearchResult.Kind.TRACK,
                    payload = mapOf("id" to track.id, "kind" to "track")
                )
            }
        }

        for (album in albums) {
            val artist = artistIndex[album.artistID]?.name ?: ""
            if (album.title.lowercase().contains(needle) ||
                artist.lowercase().contains(needle)
            ) {
                results += SearchResult(
                    id = album.id,
                    title = album.title,
                    subtitle = "$artist — ${album.year}",
                    kind = SearchResult.Kind.ALBUM,
                    payload = mapOf("id" to album.id, "kind" to "album")
                )
            }
        }

        for (artist in artists) {
            if (artist.name.lowercase().contains(needle) ||
                artist.genre.lowercase().contains(needle)
            ) {
                results += SearchResult(
                    id = artist.id,
                    title = artist.name,
                    subtitle = artist.genre,
                    kind = SearchResult.Kind.ARTIST,
                    payload = mapOf("id" to artist.id, "kind" to "artist")
                )
            }
        }

        for (playlist in playlists) {
            if (playlist.title.lowercase().contains(needle) ||
                playlist.subtitle.lowercase().contains(needle)
            ) {
                results += SearchResult(
                    id = playlist.id,
                    title = playlist.title,
                    subtitle = playlist.subtitle,
                    kind = SearchResult.Kind.PLAYLIST,
                    payload = mapOf("id" to playlist.id, "kind" to "playlist")
                )
            }
        }

        return results
    }

    companion object {
        // The generator constants are retained for the seeded helpers that still
        // use them; the *records* now come from the canonical library.json.
        const val SEED_VALUE = 20240917
        const val SEED_MULTIPLIER = 1103515245
        const val SEED_INCREMENT = 12345
        const val SEED_MASK = 0x7FFFFFFF

        /**
         * The canonical library, read from `res/raw/library.json`.
         *
         * That file is a byte-identical copy of `packages/shared/library.json`,
         * which is generated from the web app. Every platform therefore
         * presents exactly the same records.
         */
        fun seeded(context: Context): Library {
            val raw = try {
                context.resources.openRawResource(R.raw.library)
                    .bufferedReader().use { it.readText() }
            } catch (error: Exception) {
                null
            }
            if (raw == null) return Library(emptyList(), emptyList(), emptyList(), emptyList())

            val root = try {
                JSONObject(raw)
            } catch (error: Exception) {
                return Library(emptyList(), emptyList(), emptyList(), emptyList())
            }

            val artists = root.optJSONArray("artists").mapObjects { entry ->
                Artist(
                    id = entry.optString("id"),
                    name = entry.optString("name"),
                    genre = entry.optString("genre"),
                    albumIDs = entry.optJSONArray("albumIds").toStringList()
                )
            }

            val albums = root.optJSONArray("albums").mapObjects { entry ->
                Album(
                    id = entry.optString("id"),
                    title = entry.optString("title"),
                    artistID = entry.optString("artistId"),
                    year = entry.optInt("year"),
                    genre = entry.optString("genre"),
                    trackIDs = entry.optJSONArray("trackIds").toStringList(),
                    accent = entry.optString("accentHex").toAccentLong()
                )
            }

            val tracks = root.optJSONArray("tracks").mapObjects { entry ->
                Track(
                    id = entry.optString("id"),
                    title = entry.optString("title"),
                    artistID = entry.optString("artistId"),
                    albumID = entry.optString("albumId"),
                    durationSeconds = entry.optInt("duration"),
                    trackNumber = entry.optInt("trackNumber"),
                    year = entry.optInt("year"),
                    genre = entry.optString("genre")
                )
            }

            val playlists = root.optJSONArray("playlists").mapObjects { entry ->
                Playlist(
                    id = entry.optString("id"),
                    title = entry.optString("title"),
                    subtitle = entry.optString("description"),
                    trackIDs = entry.optJSONArray("trackIds").toStringList()
                )
            }

            return Library(artists, albums, tracks, playlists)
        }

        /** "#f25022" -> 0xF25022 as a Long. */
        private fun String.toAccentLong(): Long {
            val trimmed = if (startsWith("#")) substring(1) else this
            return trimmed.toLongOrNull(16) ?: 0xFF4E00
        }

        private fun JSONArray?.toStringList(): List<String> {
            if (this == null) return emptyList()
            val result = ArrayList<String>(length())
            for (index in 0 until length()) {
                result += optString(index)
            }
            return result
        }

        private inline fun <T> JSONArray?.mapObjects(transform: (JSONObject) -> T): List<T> {
            if (this == null) return emptyList()
            val result = ArrayList<T>(length())
            for (index in 0 until length()) {
                val entry = optJSONObject(index) ?: continue
                result += transform(entry)
            }
            return result
        }
    }
}
