import AppIntents
import Foundation

// =============================================================================
// MARK: - Contract §10 — the Spotlight semantic index
// =============================================================================
//
// Contract §10: "`AppIntents` entity schemas add them to the **Spotlight
// semantic index** (macOS 27)."
//
// The entity below describes one library item so that the system can offer
// it in Spotlight, in the Shortcuts gallery and in the intent suggestions.
// The newest APIs are guarded with `@available` so the shell keeps building
// against older SDKs.

/// One library item as the system sees it.
@available(macOS 14.0, *)
struct ZodeLibraryEntity: AppEntity, Identifiable {

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Zode Library Item")
    static var defaultQuery = ZodeLibraryEntityQuery()

    let id: String
    let title: String
    let subtitle: String
    let kind: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
    }

    init(id: String, title: String, subtitle: String, kind: String) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
    }

    init(item: ZodeLibraryItem) {
        self.init(
            id: item.id,
            title: item.title,
            subtitle: item.subtitle ?? item.kind.rawValue,
            kind: item.kind.rawValue
        )
    }
}

/// The default query of `ZodeLibraryEntity`.
@available(macOS 14.0, *)
struct ZodeLibraryEntityQuery: EntityQuery {

    func entities(for identifiers: [ZodeLibraryEntity.ID]) async throws -> [ZodeLibraryEntity] {
        let wanted = Set(identifiers)
        return ZodeIntentsBridge.libraryProvider?()
            .map { ZodeLibraryEntity(item: $0) }
            .filter { wanted.contains($0.id) } ?? []
    }

    func suggestedEntities() async throws -> [ZodeLibraryEntity] {
        (ZodeIntentsBridge.libraryProvider?() ?? []).map { ZodeLibraryEntity(item: $0) }
    }
}

/// The string query that feeds the Spotlight semantic index.
@available(macOS 14.0, *)
struct ZodeLibraryEntityStringQuery: EntityStringQuery {

    // EntityStringQuery inherits from EntityQuery, so the lookup by
    // identifier is required as well as the search by string.  Without it the
    // type does not conform to EntityQuery (or to DynamicOptionsProvider,
    // whose result type is inferred from it).
    func entities(for identifiers: [ZodeLibraryEntity.ID]) async throws -> [ZodeLibraryEntity] {
        let wanted = Set(identifiers)
        return ZodeIntentsBridge.libraryProvider?()
            .map { ZodeLibraryEntity(item: $0) }
            .filter { wanted.contains($0.id) } ?? []
    }

    func suggestedEntities() async throws -> [ZodeLibraryEntity] {
        (ZodeIntentsBridge.libraryProvider?() ?? []).map { ZodeLibraryEntity(item: $0) }
    }

    func entities(matching string: String) async throws -> [ZodeLibraryEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let items = ZodeIntentsBridge.libraryProvider?() ?? []
        guard !needle.isEmpty else {
            return items.map { ZodeLibraryEntity(item: $0) }
        }
        return items
            .filter { item in
                if item.title.lowercased().contains(needle) { return true }
                if let subtitle = item.subtitle, subtitle.lowercased().contains(needle) { return true }
                return item.kind.rawValue.contains(needle)
            }
            .map { ZodeLibraryEntity(item: $0) }
    }
}
