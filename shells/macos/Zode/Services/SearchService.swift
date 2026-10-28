import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

// =============================================================================
// MARK: - Contract §10 — system search
// =============================================================================
//
// The shell keeps a small, in-memory index of the library and mirrors it
// into CoreSpotlight (`CSSearchableIndex`) so that Spotlight surfaces the
// items. The `AppEntity` schemas in `Intents/ZodeEntities.swift` add the
// same items to the Spotlight *semantic* index on the SDKs that support it.
//
// The contract's request table has no "sync the library" verb, so the index
// is seeded from the library file the web app ships (see `ZodeResources`).

/// One item of the library.
struct ZodeLibraryItem: Equatable {

    /// The kinds defined by contract §2.1.
    enum Kind: String {
        case track
        case album
        case artist
        case playlist
        case task
        case file
        case action

        /// Falls back to `action` for unknown kinds.
        init(rawValue: String) {
            self = Kind(rawValue: rawValue) ?? .action
        }
    }

    let id: String
    let title: String
    let subtitle: String?
    let kind: Kind
    let payload: [String: String]

    /// Builds a library item.
    ///
    /// Written out because the `init?(json:)` below suppresses the
    /// memberwise initialiser.
    init(id: String, title: String, subtitle: String?, kind: Kind, payload: [String: String]) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
        self.payload = payload
    }

    /// The JSON representation used on the wire (contract §2.1).
    var json: [String: Any] {
        var json: [String: Any] = [
            "id": id,
            "title": title,
            "kind": kind.rawValue
        ]
        if let subtitle { json["subtitle"] = subtitle }
        if !payload.isEmpty { json["payload"] = payload }
        return json
    }

    /// Reads an item from the library JSON.
    init?(json: [String: Any]) {
        guard let id = json["id"] as? String else { return nil }
        let title = (json["title"] as? String) ?? (json["name"] as? String) ?? id
        let subtitle = (json["subtitle"] as? String) ?? (json["artist"] as? String)
        let kind = Kind(rawValue: (json["kind"] as? String) ?? "action")
        var payload: [String: String] = [:]
        if let raw = json["payload"] as? [String: Any] {
            for (key, value) in raw {
                if let text = value as? String {
                    payload[key] = text
                } else if let number = value as? NSNumber {
                    payload[key] = number.stringValue
                }
            }
        }
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
        self.payload = payload
    }
}

final class SearchService {

    /// The domain the library is indexed under.
    static let domainIdentifier = "com.zode.app"

    private(set) var items: [ZodeLibraryItem] = []

    // MARK: - The in-memory index

    /// Loads the library from the JSON file the web app ships.
    ///
    /// Two shapes are understood:
    ///
    ///   * the canonical library of the web app
    ///     (`{ "artists": [ … ], "albums": [ … ], "tracks": [ … ] }`),
    ///   * a flat list of items (`{ "items": [ … ] }` or `[ … ]`) with the
    ///     `id` / `title` / `kind` fields of contract §2.1.
    @discardableResult
    func loadLibrary(from url: URL) throws -> [ZodeLibraryItem] {
        let data = try Data(contentsOf: url)
        let root = try JSONSerialization.jsonObject(with: data)

        var items: [ZodeLibraryItem] = []

        if let dictionary = root as? [String: Any] {
            if let groups = dictionary["items"] as? [[String: Any]] {
                items = groups.compactMap { ZodeLibraryItem(json: $0) }
            } else {
                // The canonical library of the web app.
                items = SearchService.items(fromCanonicalLibrary: dictionary)
            }
        } else if let array = root as? [[String: Any]] {
            items = array.compactMap { ZodeLibraryItem(json: $0) }
        }

        self.items = items
        return items
    }

    /// Maps the canonical web app library (`assets/library.json`) onto the
    /// library items of contract §2.1.
    private static func items(fromCanonicalLibrary library: [String: Any]) -> [ZodeLibraryItem] {
        var items: [ZodeLibraryItem] = []

        for artist in library["artists"] as? [[String: Any]] ?? [] {
            guard let id = artist["id"] as? String else { continue }
            items.append(ZodeLibraryItem(
                id: id,
                title: (artist["name"] as? String) ?? id,
                subtitle: nil,
                kind: .artist,
                payload: [:]
            ))
        }

        for album in library["albums"] as? [[String: Any]] ?? [] {
            guard let id = album["id"] as? String else { continue }
            var payload: [String: String] = [:]
            if let year = album["year"] as? NSNumber { payload["year"] = year.stringValue }
            if let genre = album["genre"] as? String { payload["genre"] = genre }
            if let artistId = album["artistId"] as? String { payload["artistId"] = artistId }
            items.append(ZodeLibraryItem(
                id: id,
                title: (album["title"] as? String) ?? id,
                subtitle: album["artistName"] as? String,
                kind: .album,
                payload: payload
            ))
        }

        for track in library["tracks"] as? [[String: Any]] ?? [] {
            guard let id = track["id"] as? String else { continue }
            var payload: [String: String] = [:]
            if let albumId = track["albumId"] as? String { payload["albumId"] = albumId }
            if let artistId = track["artistId"] as? String { payload["artistId"] = artistId }
            if let albumTitle = track["albumTitle"] as? String { payload["albumTitle"] = albumTitle }
            items.append(ZodeLibraryItem(
                id: id,
                title: (track["title"] as? String) ?? id,
                subtitle: track["artistName"] as? String,
                kind: .track,
                payload: payload
            ))
        }

        for playlist in library["playlists"] as? [[String: Any]] ?? [] {
            guard let id = playlist["id"] as? String else { continue }
            items.append(ZodeLibraryItem(
                id: id,
                title: (playlist["title"] as? String) ?? (playlist["name"] as? String) ?? id,
                subtitle: playlist["artistName"] as? String,
                kind: .playlist,
                payload: [:]
            ))
        }

        return items
    }

    /// Replaces the index (used by the developer commands).
    func setItems(_ items: [ZodeLibraryItem]) {
        self.items = items
    }

    /// Contract §3 `search.query` — filters the in-memory index.
    func query(_ text: String) -> [ZodeLibraryItem] {
        let needle = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { item in
            if item.title.lowercased().contains(needle) { return true }
            if let subtitle = item.subtitle, subtitle.lowercased().contains(needle) { return true }
            if item.kind.rawValue.contains(needle) { return true }
            return item.payload.values.contains { $0.lowercased().contains(needle) }
        }
    }

    // MARK: - CoreSpotlight

    /// Mirrors the library into the Spotlight index (contract §10).
    func index(items: [ZodeLibraryItem]) throws {
        guard !items.isEmpty else { return }
        let searchableItems: [CSSearchableItem] = items.map { item in
            let attributes = CSSearchableItemAttributeSet(contentType: .content)
            attributes.title = item.title
            attributes.contentDescription = item.subtitle
            attributes.keywords = [item.kind.rawValue] + Array(item.payload.values)
            attributes.relatedUniqueIdentifier = "\(Self.domainIdentifier).library"
            return CSSearchableItem(
                uniqueIdentifier: "\(Self.domainIdentifier).\(item.kind.rawValue).\(item.id)",
                domainIdentifier: Self.domainIdentifier,
                attributeSet: attributes
            )
        }
        try CSSearchableIndex.default().indexSearchableItems(searchableItems)
    }

    /// Removes everything from the Spotlight index.
    func removeAllFromIndex() {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domainIdentifier]) { _ in }
    }
}
