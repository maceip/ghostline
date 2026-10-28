//
//  Library.swift
//  ZodeMobile
//
//  The seeded library. Mirrors the web app's `src/data/library.js`: a
//  deterministic fake catalogue so screenshots and tests are stable.
//
//  The seed tables and the linear congruential generator below are duplicated
//  verbatim in the Android app
//  (`app/src/main/java/com/zode/app/data/Library.kt`) so both platforms
//  produce the *same* library. `tools/verify_swift.py` and
//  `tools/verify_android.py` assert that the tables still match
//  `mobile/tools/seed_reference.py`.
//

import Foundation

/// The whole library, indexed for fast lookups.
public struct Library: Sendable {
    public let artists: [Artist]
    public let albums: [Album]
    public let tracks: [Track]
    public let playlists: [Playlist]

    private let artistIndex: [String: Artist]
    private let albumIndex: [String: Album]
    private let trackIndex: [String: Track]
    private let playlistIndex: [String: Playlist]

    public init(
        artists: [Artist],
        albums: [Album],
        tracks: [Track],
        playlists: [Playlist]
    ) {
        self.artists = artists
        self.albums = albums
        self.tracks = tracks
        self.playlists = playlists
        self.artistIndex = Dictionary(uniqueKeysWithValues: artists.map { ($0.id, $0) })
        self.albumIndex = Dictionary(uniqueKeysWithValues: albums.map { ($0.id, $0) })
        self.trackIndex = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
        self.playlistIndex = Dictionary(uniqueKeysWithValues: playlists.map { ($0.id, $0) })
    }

    // MARK: Lookups

    public func artist(_ id: String) -> Artist? { artistIndex[id] }
    public func album(_ id: String) -> Album? { albumIndex[id] }
    public func track(_ id: String) -> Track? { trackIndex[id] }
    public func playlist(_ id: String) -> Playlist? { playlistIndex[id] }

    public func tracks(inAlbum albumID: String) -> [Track] {
        albumIndex[albumID]?.trackIDs.compactMap { trackIndex[$0] } ?? []
    }

    public func tracks(byArtist artistID: String) -> [Track] {
        tracks.filter { $0.artistID == artistID }
    }

    public func tracks(inPlaylist playlistID: String) -> [Track] {
        playlistIndex[playlistID]?.trackIDs.compactMap { trackIndex[$0] } ?? []
    }

    /// The first track of a playable item, used when `zode.play` is invoked.
    public func firstTrack(of item: PlayableItem) -> Track? {
        switch item {
        case .track(let id):
            return track(id)
        case .album(let id):
            return tracks(inAlbum: id).first
        case .artist(let id):
            return tracks(byArtist: id).first
        case .playlist(let id):
            return tracks(inPlaylist: id).first
        }
    }

    /// Every track of a playable item, in order.
    public func tracks(of item: PlayableItem) -> [Track] {
        switch item {
        case .track(let id):
            return track(id).map { [$0] } ?? []
        case .album(let id):
            return tracks(inAlbum: id)
        case .artist(let id):
            return tracks(byArtist: id)
        case .playlist(let id):
            return tracks(inPlaylist: id)
        }
    }

    // MARK: Search (contract §2 — `zode.search`)

    /// Filters the library. `kind` mirrors the contract's `SearchResult.kind`.
    public func search(_ query: String) -> [SearchResult] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }

        var results: [SearchResult] = []

        for track in tracks {
            let artist = artistIndex[track.artistID]?.name ?? ""
            if track.title.lowercased().contains(needle)
                || artist.lowercased().contains(needle)
                || track.albumID.lowercased().contains(needle) {
                results.append(
                    SearchResult(
                        id: track.id,
                        title: track.title,
                        subtitle: "\(artist) — \(track.durationLabel)",
                        kind: .track,
                        payload: ["id": track.id, "kind": "track"]
                    )
                )
            }
        }

        for album in albums {
            let artist = artistIndex[album.artistID]?.name ?? ""
            if album.title.lowercased().contains(needle)
                || artist.lowercased().contains(needle) {
                results.append(
                    SearchResult(
                        id: album.id,
                        title: album.title,
                        subtitle: "\(artist) — \(album.year)",
                        kind: .album,
                        payload: ["id": album.id, "kind": "album"]
                    )
                )
            }
        }

        for artist in artists {
            if artist.name.lowercased().contains(needle)
                || artist.genre.lowercased().contains(needle) {
                results.append(
                    SearchResult(
                        id: artist.id,
                        title: artist.name,
                        subtitle: artist.genre,
                        kind: .artist,
                        payload: ["id": artist.id, "kind": "artist"]
                    )
                )
            }
        }

        for playlist in playlists {
            if playlist.title.lowercased().contains(needle)
                || playlist.subtitle.lowercased().contains(needle) {
                results.append(
                    SearchResult(
                        id: playlist.id,
                        title: playlist.title,
                        subtitle: playlist.subtitle,
                        kind: .playlist,
                        payload: ["id": playlist.id, "kind": "playlist"]
                    )
                )
            }
        }

        return results
    }
}

// MARK: - The canonical library

/// The shape of `library.json`.
///
/// The file is a byte-identical copy of `packages/shared/library.json`, which
/// is generated from the web app (`scripts/dump_library.mjs`). Every platform
/// presents exactly these records.
struct LibraryDocument: Decodable {
    struct ArtistRecord: Decodable {
        let id: String
        let name: String
        let genre: String
        let albumIds: [String]
    }

    struct AlbumRecord: Decodable {
        let id: String
        let title: String
        let artistId: String
        let artistName: String
        let year: Int
        let genre: String
        let trackIds: [String]
        /// e.g. "#f25022" -- the flat Metro tile colour.
        let accentHex: String
    }

    struct TrackRecord: Decodable {
        let id: String
        let title: String
        let albumId: String
        let albumTitle: String
        let artistId: String
        let artistName: String
        let duration: Int
        let trackNumber: Int
        let year: Int
        let genre: String
    }

    struct PlaylistRecord: Decodable {
        let id: String
        let title: String
        let description: String
        let trackIds: [String]
    }

    let version: Int
    let artists: [ArtistRecord]
    let albums: [AlbumRecord]
    let tracks: [TrackRecord]
    let playlists: [PlaylistRecord]

    /// The library in the app's own model types.
    var library: Library {
        Library(
            artists: artists.map {
                Artist(id: $0.id, name: $0.name, genre: $0.genre, albumIDs: $0.albumIds)
            },
            albums: albums.map {
                Album(
                    id: $0.id,
                    title: $0.title,
                    artistID: $0.artistId,
                    year: $0.year,
                    genre: $0.genre,
                    trackIDs: $0.trackIds,
                    accentHex: Self.hexValue($0.accentHex)
                )
            },
            tracks: tracks.map {
                Track(
                    id: $0.id,
                    title: $0.title,
                    artistID: $0.artistId,
                    albumID: $0.albumId,
                    durationSeconds: $0.duration,
                    trackNumber: $0.trackNumber,
                    year: $0.year,
                    genre: $0.genre
                )
            },
            playlists: playlists.map {
                Playlist(id: $0.id, title: $0.title, subtitle: $0.description, trackIDs: $0.trackIds)
            }
        )
    }

    /// "#f25022" -> 0xF25022.
    static func hexValue(_ text: String) -> UInt32 {
        let trimmed = text.hasPrefix("#") ? String(text.dropFirst()) : text
        return UInt32(trimmed, radix: 16) ?? 0xFF4E00
    }
}

public extension Library {
    /// The canonical library, read from the bundled `library.json`.
    ///
    /// The web app owns the records, so the mobile clients do not generate
    /// their own catalogue: they read the same file the web app is built from.
    static func seeded() -> Library {
        guard
            let url = Bundle.main.url(forResource: "library", withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let document = try? JSONDecoder().decode(LibraryDocument.self, from: data)
        else {
            // A missing resource is a packaging bug, not a runtime condition;
            // an empty library is safer than a crash.
            return Library(artists: [], albums: [], tracks: [], playlists: [])
        }
        return document.library
    }
}
