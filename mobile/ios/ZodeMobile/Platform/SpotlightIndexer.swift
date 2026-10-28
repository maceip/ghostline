//
//  SpotlightIndexer.swift
//  ZodeMobile
//
//  System search integration (contract §10). The library is indexed with
//  CoreSpotlight so tracks, albums, artists and playlists show up in the
//  system search field; tapping a result opens the app and the deep link
//  router takes over.
//

import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

@MainActor
public final class SpotlightIndexer {
    /// The domain used for every Zode item.
    public static let domain = "com.zode.app.library"

    /// An attribute set with a content type of our own.
    ///
    /// Foundation has no `UTType` for an album, an artist or a playlist, so
    /// the type is given as a UTI string.  Spotlight does not mind, as long
    /// as it is a well formed identifier.
    private static func attributes(contentType: String) -> CSSearchableItemAttributeSet {
        let attributes = CSSearchableItemAttributeSet(contentType: .audio)
        attributes.contentType = contentType
        return attributes
    }

    private let library: Library

    public init(library: Library) {
        self.library = library
    }

    /// Indexes the whole library.
    public func indexAll() {
        var items: [CSSearchableItem] = []

        for track in library.tracks {
            let artist = library.artist(track.artistID)?.name ?? ""
            let album = library.album(track.albumID)?.title ?? ""
            let attributes = CSSearchableItemAttributeSet(contentType: .audio)
            attributes.title = track.title
            attributes.contentDescription = "\(artist) — \(album)"
            attributes.displayName = track.title
            attributes.genre = track.genre
            attributes.artist = artist
            // `albumName` and `mediaType` are macOS only, so the album goes
            // into the description instead.
            attributes.duration = NSNumber(value: track.durationSeconds)
            attributes.addedDate = Date()

            let item = CSSearchableItem(
                uniqueIdentifier: "track:\(track.id)",
                domainIdentifier: Self.domain,
                attributeSet: attributes
            )
            item.expirationDate = nil
            items.append(item)
        }

        for album in library.albums {
            let artist = library.artist(album.artistID)?.name ?? ""
            let attributes = Self.attributes(contentType: "com.zode.album")
            attributes.title = album.title
            attributes.displayName = album.title
            attributes.contentDescription = "\(artist) — \(album.year)"
            attributes.artist = artist

            let item = CSSearchableItem(
                uniqueIdentifier: "album:\(album.id)",
                domainIdentifier: Self.domain,
                attributeSet: attributes
            )
            items.append(item)
        }

        for artist in library.artists {
            let attributes = Self.attributes(contentType: "com.zode.artist")
            attributes.title = artist.name
            attributes.displayName = artist.name
            attributes.genre = artist.genre

            let item = CSSearchableItem(
                uniqueIdentifier: "artist:\(artist.id)",
                domainIdentifier: Self.domain,
                attributeSet: attributes
            )
            items.append(item)
        }

        for playlist in library.playlists {
            let attributes = Self.attributes(contentType: "com.zode.playlist")
            attributes.title = playlist.title
            attributes.displayName = playlist.title
            attributes.contentDescription = playlist.subtitle

            let item = CSSearchableItem(
                uniqueIdentifier: "playlist:\(playlist.id)",
                domainIdentifier: Self.domain,
                attributeSet: attributes
            )
            items.append(item)
        }

        CSSearchableIndex.default().indexSearchableItems(items)
    }

    /// Removes every Zode item from the index.
    public func deleteAll() {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domain])
    }

    /// The deep link a Spotlight result should open.
    public static func deepLink(for identifier: String) -> URL? {
        let parts = identifier.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        switch parts[0] {
        case "track":
            return URL(string: "zode://library/track/\(parts[1])")
        case "album":
            return URL(string: "zode://collection/album/\(parts[1])")
        case "artist":
            return URL(string: "zode://collection/artist/\(parts[1])")
        case "playlist":
            return URL(string: "zode://collection/playlist/\(parts[1])")
        default:
            return nil
        }
    }
}
