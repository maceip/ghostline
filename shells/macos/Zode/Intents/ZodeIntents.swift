import AppIntents
import Foundation

// =============================================================================
// MARK: - Contract §4 — the macOS App Intents
// =============================================================================
//
// Every intent of contract §4 has an App Intent here. The *names* and the
// *payload shapes* are the contract's; the Swift type names follow the
// mapping in contract §4.1 (`SearchLibraryIntent`, `PlayItemIntent`,
// `NewTaskIntent`, `StopTaskIntent`).
//
// The newest APIs are guarded with `@available` so the shell keeps building
// against older SDKs, and the app model installs the handlers at launch.

// MARK: - zode.search

/// Contract §4.1 — `SearchLibraryIntent` → Spotlight `AppEntity`.
@available(macOS 14.0, *)
struct SearchLibraryIntent: AppIntent {

    static var title: LocalizedStringResource = "Search Zode Library"
    static var description = IntentDescription("Search the Zode library for a track, album, artist or playlist.")
    static var openAppWhenRun = false

    @Parameter(title: "Query")
    var query: String

    init() {}

    init(query: String) {
        self.query = query
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let results = ZodeIntentsBridge.search(query)
        ZodeIntentsBridge.perform("zode.search", payload: ["query": query])
        let count = String(results.count)
        return .result(dialog: "Found \(count) result\(results.count == 1 ? "" : "s") for \(query)")
    }
}

// MARK: - zode.play / zode.pause / zode.next / zode.previous

/// Contract §4.1 — `PlayItemIntent` → also a media intent for Siri.
@available(macOS 14.0, *)
struct PlayItemIntent: AppIntent {

    static var title: LocalizedStringResource = "Play in Zode"
    static var description = IntentDescription("Start playing a track, album, artist or playlist in Zode.")
    static var openAppWhenRun = false

    @Parameter(title: "Item id")
    var id: String

    @Parameter(title: "Kind")
    var kind: String

    init() {}

    init(id: String, kind: String) {
        self.id = id
        self.kind = kind
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        ZodeIntentsBridge.perform("zode.play", payload: ["id": id, "kind": kind])
        return .result(dialog: "Playing \(id) in Zode")
    }
}

/// Contract §4.1 — media intent.
@available(macOS 14.0, *)
struct PauseIntent: AppIntent {

    static var title: LocalizedStringResource = "Pause Zode"
    static var description = IntentDescription("Pause the current Zode playback.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        ZodeIntentsBridge.perform("zode.pause", payload: [:])
        return .result(dialog: "Paused")
    }
}

/// Contract §4.1 — media intent.
@available(macOS 14.0, *)
struct NextIntent: AppIntent {

    static var title: LocalizedStringResource = "Next Track in Zode"
    static var description = IntentDescription("Skip to the next track in Zode.")
    static var openAppWhenRun = false

    @Parameter(title: "Track id")
    var id: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var payload: [String: Any] = [:]
        if let id { payload["id"] = id }
        ZodeIntentsBridge.perform("zode.next", payload: payload)
        return .result(dialog: "Skipping to the next track")
    }
}

/// Contract §4.1 — media intent.
@available(macOS 14.0, *)
struct PreviousIntent: AppIntent {

    static var title: LocalizedStringResource = "Previous Track in Zode"
    static var description = IntentDescription("Skip to the previous track in Zode.")
    static var openAppWhenRun = false

    @Parameter(title: "Track id")
    var id: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var payload: [String: Any] = [:]
        if let id { payload["id"] = id }
        ZodeIntentsBridge.perform("zode.previous", payload: payload)
        return .result(dialog: "Skipping to the previous track")
    }
}

// MARK: - zode.agent.newTask / zode.agent.stop

/// Contract §4.1 — `NewTaskIntent` (`openAppWhenRun = true`).
@available(macOS 14.0, *)
struct NewTaskIntent: AppIntent {

    static var title: LocalizedStringResource = "New Zode Agent Task"
    static var description = IntentDescription("Start a new Zode agent task.")
    static var openAppWhenRun = true

    @Parameter(title: "Prompt")
    var prompt: String

    init() {}

    init(prompt: String) {
        self.prompt = prompt
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        ZodeIntentsBridge.perform("zode.agent.newTask", payload: ["prompt": prompt])
        return .result(dialog: "Starting a new agent task")
    }
}

/// Contract §4.1 — `StopTaskIntent`.
@available(macOS 14.0, *)
struct StopTaskIntent: AppIntent {

    static var title: LocalizedStringResource = "Stop the Zode Agent Task"
    static var description = IntentDescription("Stop the running Zode agent task.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        ZodeIntentsBridge.perform("zode.agent.stop", payload: [:])
        return .result(dialog: "Stopping the agent task")
    }
}

// MARK: - zode.show

/// Contract §4.1 — `zode.show` → an `AppIntent` with `openAppWhenRun`.
@available(macOS 14.0, *)
struct ShowViewIntent: AppIntent {

    /// The views contract §4 defines.
    enum View: String, AppEnum, CaseIterable {
        case nowPlaying = "now-playing"
        case collection = "collection"
        case library = "library"
        case search = "search"
        case agent = "agent"

        static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Zode View")
        static var caseDisplayRepresentations: [View: DisplayRepresentation] = [
            .nowPlaying: DisplayRepresentation(title: "Now Playing"),
            .collection: DisplayRepresentation(title: "Collection"),
            .library: DisplayRepresentation(title: "Library"),
            .search: DisplayRepresentation(title: "Search"),
            .agent: DisplayRepresentation(title: "Agent")
        ]
    }

    static var title: LocalizedStringResource = "Show a Zode View"
    static var description = IntentDescription("Show a view of the Zode app.")
    static var openAppWhenRun = true

    @Parameter(title: "View")
    var view: View

    init() {}

    init(view: View) {
        self.view = view
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        ZodeIntentsBridge.perform("zode.show", payload: ["view": view.rawValue])
        return .result(dialog: "Showing \(view.rawValue)")
    }
}

// MARK: - Shortcuts / Spotlight exposure

/// Exposes the intents to Shortcuts and Spotlight.
@available(macOS 14.0, *)
struct ZodeAppShortcuts: AppShortcutsProvider {

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SearchLibraryIntent(),
            phrases: ["Search in \(.applicationName)"],
            shortTitle: "Search Library",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: ShowViewIntent(),
            phrases: ["Open \(.applicationName)"],
            shortTitle: "Open Zode",
            systemImageName: "music.note"
        )
    }
}
