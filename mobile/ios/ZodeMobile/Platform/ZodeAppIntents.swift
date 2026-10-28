//
//  ZodeAppIntents.swift
//  ZodeMobile
//
//  App Intents + Media Intents (contract §4.1).
//
//  Every intent carries the canonical contract name in `Self.contractIntentName`
//  so the mapping is obvious:
//
//      zode.search          -> SearchLibraryIntent
//      zode.play            -> PlayItemIntent
//      zode.pause           -> PausePlaybackIntent   (Media Intents)
//      zode.next            -> NextTrackIntent       (Media Intents)
//      zode.previous        -> PreviousTrackIntent   (Media Intents)
//      zode.agent.newTask   -> NewTaskIntent
//      zode.agent.stop      -> StopTaskIntent
//      zode.show            -> ShowViewIntent
//
//  Newer APIs are guarded with `@available` so the app still builds against
//  the iOS 17 deployment target's lower bound.
//

import AppIntents
import Foundation

// The result of an App Intent is spelled `AppIntents.IntentResult` here,
// because this target also has a model called `IntentResult` — the wire
// format of contract §1 — and the local one would otherwise shadow the
// framework's protocol.

// MARK: - Entity

/// A library item that can be played.
@available(iOS 16.0, *)
public struct ZodeItemEntity: AppEntity, Identifiable, Hashable {
    public static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Zode Item")
    public static var defaultQuery = ZodeItemQuery()

    public let id: String
    public let title: String
    public let subtitle: String
    public let kind: String

    public init(id: String, title: String, subtitle: String, kind: String) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
    }

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(title)",
            subtitle: "\(subtitle)"
        )
    }
}

/// Resolves `ZodeItemEntity` values out of the shared library.
@available(iOS 16.0, *)
public struct ZodeItemQuery: EntityQuery {
    public init() {}

    public func entities(for identifiers: [String]) async throws -> [ZodeItemEntity] {
        identifiers.compactMap { ZodeItemEntity.make(id: $0) }
    }

    public func suggestedEntities() async throws -> [ZodeItemEntity] {
        ZodeItemEntity.suggestions()
    }
}

@available(iOS 16.0, *)
public extension ZodeItemEntity {
    /// The shared library the intents act on.
    static var library: Library { IntentLibrary.shared }

    static func make(id: String) -> ZodeItemEntity? {
        if let track = library.track(id) {
            let artist = library.artist(track.artistID)?.name ?? ""
            return ZodeItemEntity(
                id: track.id,
                title: track.title,
                subtitle: "\(artist) — \(albumTitle(track))",
                kind: "track"
            )
        }
        if let album = library.album(id) {
            let artist = library.artist(album.artistID)?.name ?? ""
            return ZodeItemEntity(
                id: album.id,
                title: album.title,
                subtitle: "\(artist) — \(album.year)",
                kind: "album"
            )
        }
        if let artist = library.artist(id) {
            return ZodeItemEntity(id: artist.id, title: artist.name, subtitle: artist.genre, kind: "artist")
        }
        if let playlist = library.playlist(id) {
            return ZodeItemEntity(
                id: playlist.id,
                title: playlist.title,
                subtitle: playlist.subtitle,
                kind: "playlist"
            )
        }
        return nil
    }

    static func suggestions() -> [ZodeItemEntity] {
        library.albums.prefix(8).map { album in
            ZodeItemEntity(
                id: album.id,
                title: album.title,
                subtitle: library.artist(album.artistID)?.name ?? "",
                kind: "album"
            )
        }
    }

    private static func albumTitle(_ track: Track) -> String {
        library.album(track.albumID)?.title ?? ""
    }
}

/// A tiny holder so the intents do not need a global singleton of their own.
@available(iOS 16.0, *)
public enum IntentLibrary {
    public static let shared = Library.seeded()
}

// MARK: - zode.search

@available(iOS 16.0, *)
public struct SearchLibraryIntent: AppIntent {
    public static var title: LocalizedStringResource = "Search Zode"
    public static var description = IntentDescription("Search the Zode library.")
    public static var openAppWhenRun = true

    /// The canonical contract name.
    public static let contractIntentName = "zode.search"

    @Parameter(title: "Query")
    public var query: String

    public init() {}

    public init(query: String) {
        self.query = query
    }

    public func perform() async throws -> some AppIntents.IntentResult & ProvidesDialog {
        await IntentBridge.shared.perform(
            Self.contractIntentName,
            payload: ["query": query]
        )
        return .result(dialog: "Searching Zode for \(query)")
    }
}

// MARK: - zode.play

@available(iOS 16.0, *)
public struct PlayItemIntent: AppIntent {
    public static var title: LocalizedStringResource = "Play in Zode"
    public static var description = IntentDescription("Play a track, album, artist or playlist.")
    public static var openAppWhenRun = true

    /// The canonical contract name.
    public static let contractIntentName = "zode.play"

    @Parameter(title: "Item")
    public var item: ZodeItemEntity

    public init() {}

    public init(item: ZodeItemEntity) {
        self.item = item
    }

    public func perform() async throws -> some AppIntents.IntentResult & ProvidesDialog {
        await IntentBridge.shared.perform(
            Self.contractIntentName,
            payload: ["id": item.id, "kind": item.kind]
        )
        return .result(dialog: "Playing \(item.title)")
    }
}

// MARK: - zode.pause / zode.next / zode.previous (Media Intents)

@available(iOS 16.0, *)
public struct PausePlaybackIntent: AudioPlaybackIntent {
    public static var title: LocalizedStringResource = "Pause Zode"
    public static var description = IntentDescription("Pause Zode playback.")
    public static var openAppWhenRun = false

    /// The canonical contract name.
    public static let contractIntentName = "zode.pause"

    public init() {}

    public func perform() async throws -> some AppIntents.IntentResult {
        await IntentBridge.shared.perform(Self.contractIntentName)
        return .result()
    }
}

@available(iOS 16.0, *)
public struct NextTrackIntent: AudioPlaybackIntent {
    public static var title: LocalizedStringResource = "Next Track in Zode"
    public static var description = IntentDescription("Skip to the next track.")
    public static var openAppWhenRun = false

    /// The canonical contract name.
    public static let contractIntentName = "zode.next"

    public init() {}

    public func perform() async throws -> some AppIntents.IntentResult {
        await IntentBridge.shared.perform(Self.contractIntentName)
        return .result()
    }
}

@available(iOS 16.0, *)
public struct PreviousTrackIntent: AudioPlaybackIntent {
    public static var title: LocalizedStringResource = "Previous Track in Zode"
    public static var description = IntentDescription("Skip to the previous track.")
    public static var openAppWhenRun = false

    /// The canonical contract name.
    public static let contractIntentName = "zode.previous"

    public init() {}

    public func perform() async throws -> some AppIntents.IntentResult {
        await IntentBridge.shared.perform(Self.contractIntentName)
        return .result()
    }
}

// MARK: - zode.agent.newTask

@available(iOS 16.0, *)
public struct NewTaskIntent: AppIntent {
    public static var title: LocalizedStringResource = "New Zode Agent Task"
    public static var description = IntentDescription("Start a new agent task in Zode.")
    public static var openAppWhenRun = true

    /// The canonical contract name.
    public static let contractIntentName = "zode.agent.newTask"

    @Parameter(title: "Prompt")
    public var prompt: String

    public init() {}

    public init(prompt: String) {
        self.prompt = prompt
    }

    public func perform() async throws -> some AppIntents.IntentResult & ProvidesDialog {
        await IntentBridge.shared.perform(
            Self.contractIntentName,
            payload: ["prompt": prompt]
        )
        return .result(dialog: "Starting a new agent task")
    }
}

// MARK: - zode.agent.stop

@available(iOS 16.0, *)
public struct StopTaskIntent: AppIntent {
    public static var title: LocalizedStringResource = "Stop the Zode Agent"
    public static var description = IntentDescription("Stop the running agent task.")
    public static var openAppWhenRun = true

    /// The canonical contract name.
    public static let contractIntentName = "zode.agent.stop"

    public init() {}

    public func perform() async throws -> some AppIntents.IntentResult {
        await IntentBridge.shared.perform(Self.contractIntentName)
        return .result()
    }
}

// MARK: - zode.show

@available(iOS 16.0, *)
public struct ShowViewIntent: AppIntent {
    public static var title: LocalizedStringResource = "Show a Zode View"
    public static var description = IntentDescription("Open a Zode view.")
    public static var openAppWhenRun = true

    /// The canonical contract name.
    public static let contractIntentName = "zode.show"

    /// The five views, matching contract §4.
    public enum View: String, AppEnum {
        case nowPlaying
        case collection
        case library
        case search
        case agent

        public static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "View")
        public static var caseDisplayRepresentations: [View: DisplayRepresentation] = [
            .nowPlaying: "Now Playing",
            .collection: "Collection",
            .library: "Library",
            .search: "Search",
            .agent: "Agent",
        ]
    }

    @Parameter(title: "View")
    public var view: View

    public init() {}

    public init(view: View) {
        self.view = view
    }

    public func perform() async throws -> some AppIntents.IntentResult & ProvidesDialog {
        let raw: String
        switch view {
        case .nowPlaying: raw = "now-playing"
        case .collection: raw = "collection"
        case .library: raw = "library"
        case .search: raw = "search"
        case .agent: raw = "agent"
        }
        await IntentBridge.shared.perform(
            Self.contractIntentName,
            payload: ["view": raw]
        )
        return .result(dialog: "Opening Zode")
    }
}

// MARK: - Shortcuts

@available(iOS 16.0, *)
public struct ZodeShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SearchLibraryIntent(),
            phrases: ["Search \(.applicationName)"],
            shortTitle: "Search",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: NewTaskIntent(),
            phrases: ["New task in \(.applicationName)"],
            shortTitle: "New Task",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: ShowViewIntent(),
            phrases: ["Open \(.applicationName)"],
            shortTitle: "Open",
            systemImageName: "play.rectangle"
        )
    }
}

// MARK: - Bridge

public extension Notification.Name {
    /// Posted when an App Intent asks the running app to do something.
    static let zodeAppIntent = Notification.Name("com.zode.app.intent")
}

/// Forwards the intents into the running app.
///
/// `AppIntent.perform()` can run in a background extension, so the bridge
/// posts the canonical intent to the main app through a notification; the
/// running `AppState` picks it up. When the app is not running, the intent is
/// delivered through the deep link router on launch.
@available(iOS 16.0, *)
public actor IntentBridge {
    public static let shared = IntentBridge()

    /// Posted when an intent arrives from outside the app.
    public static let notification = Notification.Name.zodeAppIntent

    public init() {}

    public func perform(_ intent: String, payload: [String: String] = [:]) {
        var info: [String: Any] = payload
        info["intent"] = intent
        NotificationCenter.default.post(name: Notification.Name.zodeAppIntent, object: nil, userInfo: info)
    }
}
