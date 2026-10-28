//
//  AppState.swift
//  ZodeMobile
//
//  The single store the whole app reads from: library, agent, haptics,
//  playback, attachments, theme and the capability report from contract §2.
//
//  It also implements the intent surface from contract §4 -- the *same*
//  intent names the web app and the desktop shells use.
//

import Combine
import Foundation

@MainActor
public final class AppState: ObservableObject {
    /// The capability report from contract §2.
    public struct Capabilities: Sendable {
        public var haptics: Bool
        public var attachments: Bool
        public var notifications: Bool
        public var intents: Bool
        public var journal: Bool
        public var search: Bool
        public var windowControl: Bool

        public static let iOS = Capabilities(
            haptics: true,
            attachments: true,
            notifications: true,
            intents: true,
            // iOS has no system "journal" API (that is the macOS Journaling
            // Suggestions framework); the app keeps a local activity log and
            // reports the capability honestly.
            journal: false,
            search: true,
            // Phones have no window chrome to control.
            windowControl: false
        )
    }

    // MARK: - Stored objects

    public let library: Library
    public let agent: AgentEngine
    public let haptics: HapticEngine
    public let router: Router
    public let notifications: NotificationSupport
    public let spotlight: SpotlightIndexer
    public let journal: JournalingSupport
    public let intentRouter: IntentRouter

    // MARK: - Published state

    @Published public var theme: AppTheme = .ink
    @Published public var playback: PlaybackState = PlaybackState()
    @Published public var attachments: [Attachment] = []
    @Published public var searchQuery: String = ""
    @Published public var searchResults: [SearchResult] = []
    @Published public var queue: [String] = []
    @Published public var banner: String?

    public var capabilities: Capabilities {
        var capabilities = Capabilities.iOS
        capabilities.haptics = haptics.capabilitiesHaptics
        capabilities.notifications = notifications.isAuthorized
        return capabilities
    }

    private var cancellables: Set<AnyCancellable> = []
    /// The cancellation closures of the agent event handlers.  `onEvent`
    /// hands one back so the handler can be removed again; throwing it away
    /// is what the compiler calls "function is unused".
    private var agentEventCancellations: [() -> Void] = []
    private var attachmentCounter = 0

    deinit {
        // The agent event handlers are removed again when the app state goes
        // away, so nothing keeps a strong reference to it.
        for cancel in agentEventCancellations {
            cancel()
        }
    }

    public init() {
        library = Library.seeded()
        agent = AgentEngine()
        haptics = HapticEngine()
        router = Router()
        notifications = NotificationSupport()
        spotlight = SpotlightIndexer(library: library)
        journal = JournalingSupport()
        intentRouter = IntentRouter()

        intentRouter.appState = self
        notifications.onAction = { [weak self] id, action in
            self?.handleNotificationAction(id: id, action: action)
        }

        // The agent drives the haptics: `working` on start, `done` on success,
        // `error` on failure. These are the same triggers the web app uses.
        agentEventCancellations.append(agent.onEvent { [weak self] event in
            self?.handleAgentEvent(event)
        })

        // App Intents that arrive while the app is running.
        NotificationCenter.default.publisher(for: .zodeAppIntent)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in
                guard let self,
                      let info = note.userInfo,
                      let intent = info["intent"] as? String else { return }
                var payload: [String: String] = [:]
                for (rawKey, value) in info {
                    // The user info of a notification is [AnyHashable: Any].
                    guard let key = rawKey as? String, key != "intent" else { continue }
                    if let text = value as? String {
                        payload[key] = text
                    }
                }
                _ = self.performIntent(intent, payload: payload)
            }
            .store(in: &cancellables)

        startTicker()

        // A first task so the Agent view is never empty on launch.
        agent.start(prompt: "Build a late-night set from the library")
    }

    // MARK: - Theme

    public func toggleTheme() {
        theme = theme == .ink ? .paper : .ink
        haptics.play("select")
    }

    // MARK: - Playback

    public func play(_ item: PlayableItem) {
        let tracks = library.tracks(of: item)
        guard let first = tracks.first else { return }
        queue = tracks.map(\.id)
        playback.currentTrackID = first.id
        playback.isPlaying = true
        playback.elapsed = 0
        haptics.play("select")
    }

    public func playTrack(_ trackID: String) {
        guard let track = library.track(trackID) else { return }
        if let index = queue.firstIndex(of: trackID), index > 0 {
            queue = Array(queue[index...])
        } else {
            queue = library.tracks(inAlbum: track.albumID).map(\.id)
        }
        playback.currentTrackID = trackID
        playback.isPlaying = true
        playback.elapsed = 0
        haptics.play("select")
    }

    public func togglePlayback() {
        playback.isPlaying.toggle()
        haptics.play("select")
    }

    public func next() {
        guard !queue.isEmpty else { return }
        guard let current = playback.currentTrackID,
              let index = queue.firstIndex(of: current) else { return }
        let nextIndex = (index + 1) % queue.count
        playback.currentTrackID = queue[nextIndex]
        playback.elapsed = 0
        playback.isPlaying = true
        haptics.play("tick")
    }

    public func previous() {
        guard !queue.isEmpty else { return }
        guard let current = playback.currentTrackID,
              let index = queue.firstIndex(of: current) else { return }
        let previousIndex = (index - 1 + queue.count) % queue.count
        playback.currentTrackID = queue[previousIndex]
        playback.elapsed = 0
        playback.isPlaying = true
        haptics.play("tick")
    }

    /// Called by the scrubber. `tick` fires on every change, as in the web app.
    public func scrub(to fraction: Double) {
        guard let trackID = playback.currentTrackID,
              let track = library.track(trackID) else { return }
        playback.elapsed = max(0, min(1, fraction)) * Double(track.durationSeconds)
        haptics.play("tick")
    }

    public var currentTrack: Track? {
        guard let id = playback.currentTrackID else { return nil }
        return library.track(id)
    }

    public var currentAlbum: Album? {
        guard let track = currentTrack else { return nil }
        return library.album(track.albumID)
    }

    public var currentArtist: Artist? {
        guard let track = currentTrack else { return nil }
        return library.artist(track.artistID)
    }

    private func startTicker() {
        let ticker = Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                self?.advancePlayback()
            }
        cancellables.insert(ticker)
    }

    private func advancePlayback() {
        guard playback.isPlaying,
              let trackID = playback.currentTrackID,
              let track = library.track(trackID) else { return }
        let next = playback.elapsed + 1
        if next >= Double(track.durationSeconds) {
            self.next()
        } else {
            playback.elapsed = next
        }
    }

    // MARK: - Navigation

    public func show(_ view: AppView) {
        guard router.view != view else { return }
        router.view = view
        haptics.play("open")
    }

    // MARK: - Search

    public func updateSearch(_ query: String) {
        searchQuery = query
        searchResults = search(query)
    }

    /// Contract §2 — `search(query)`. Library hits, agent tasks, attachments
    /// and the runnable actions.
    public func search(_ query: String) -> [SearchResult] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }

        var results = library.search(query)

        for task in agent.tasks where task.prompt.lowercased().contains(needle) {
            results.append(
                SearchResult(
                    id: task.id,
                    title: task.prompt,
                    subtitle: task.state.rawValue.capitalized,
                    kind: .task,
                    payload: ["id": task.id, "kind": "task"]
                )
            )
        }

        for attachment in attachments where attachment.name.lowercased().contains(needle) {
            results.append(
                SearchResult(
                    id: attachment.id,
                    title: attachment.name,
                    subtitle: attachment.sizeLabel,
                    kind: .file,
                    payload: ["id": attachment.id, "kind": "file"]
                )
            )
        }

        if needle.contains("play") {
            for album in library.albums.prefix(3) {
                results.append(
                    SearchResult(
                        id: "action-play-\(album.id)",
                        title: "Play \(album.title)",
                        subtitle: "Action",
                        kind: .action,
                        payload: ["id": album.id, "kind": "album", "action": "play"]
                    )
                )
            }
        }

        return results
    }

    /// The results grouped by kind, in the contract's order.
    public var groupedSearchResults: [(kind: SearchResult.Kind, results: [SearchResult])] {
        SearchResult.Kind.allCases.compactMap { kind in
            let matches = searchResults.filter { $0.kind == kind }
            return matches.isEmpty ? nil : (kind, matches)
        }
    }

    // MARK: - Attachments

    /// Contract §8 — an attachment arrived.
    public func receive(_ attachment: Attachment) {
        attachments.insert(attachment, at: 0)
        agent.attach(attachment)
        haptics.play("attach")
        banner = "Received \(attachment.name)"
    }

    /// Contract §8 — a file was dropped onto the app.
    public func receiveDrop(_ attachment: Attachment) {
        attachments.insert(attachment, at: 0)
        agent.attach(attachment)
        haptics.play("drop")
        banner = "Dropped \(attachment.name)"
    }

    /// Builds an attachment for a picked file.
    public func makeAttachment(
        name: String,
        path: String,
        mimeType: String,
        size: Int,
        source: Attachment.Source
    ) -> Attachment {
        attachmentCounter += 1
        return Attachment(
            id: String(format: "att-%02d", attachmentCounter),
            name: name,
            path: path,
            mimeType: mimeType,
            size: size,
            source: source
        )
    }

    // MARK: - Agent

    public func startTask(prompt: String, attachments: [Attachment] = []) {
        agent.start(prompt: prompt, attachments: attachments)
    }

    public func stopTask() {
        agent.stop()
    }

    private func handleAgentEvent(_ event: AgentEngine.Event) {
        switch event {
        case .started:
            haptics.play("working", loop: true)
        case .progress:
            break
        case .completed:
            haptics.stop("working")
            haptics.play("done")
            notifications.post(title: "Zode", body: "The agent finished your task.")
        case .failed:
            haptics.stop("working")
            haptics.play("error")
            notifications.post(title: "Zode", body: "The agent could not finish that task.")
        case .stopped:
            haptics.stop("working")
            haptics.play("close")
        }
    }

    // MARK: - Notifications

    private func handleNotificationAction(id: String, action: String) {
        if action == "play" {
            show(.nowPlaying)
        } else if action == "agent" {
            show(.agent)
        }
    }

    // MARK: - Intents (contract §4)

    /// Runs a named intent. This is the same surface the App Intents, the
    /// deep link router and the Spotlight actions call.
    @discardableResult
    public func performIntent(_ intent: String, payload: [String: String] = [:]) -> IntentResult {
        switch intent {
        case ZodeIntent.search.rawValue:
            let query = payload["query"] ?? ""
            show(.search)
            updateSearch(query)
            return .success(query)

        case ZodeIntent.play.rawValue:
            let id = payload["id"] ?? ""
            let kind = payload["kind"] ?? "track"
            guard let item = PlayableItem.parse(kind: kind, id: id) else {
                return .failure("Unknown item kind '\(kind)'")
            }
            play(item)
            show(.nowPlaying)
            return .success(id)

        case ZodeIntent.pause.rawValue:
            playback.isPlaying = false
            haptics.play("select")
            return .success(nil)

        case ZodeIntent.next.rawValue:
            next()
            return .success(playback.currentTrackID)

        case ZodeIntent.previous.rawValue:
            previous()
            return .success(playback.currentTrackID)

        case ZodeIntent.agentNewTask.rawValue:
            let prompt = payload["prompt"] ?? ""
            show(.agent)
            startTask(prompt: prompt)
            return .success(prompt)

        case ZodeIntent.agentStop.rawValue:
            stopTask()
            return .success(nil)

        case ZodeIntent.attach.rawValue:
            let name = payload["name"] ?? "Attachment"
            let attachment = makeAttachment(
                name: name,
                path: payload["path"] ?? "",
                mimeType: payload["mimeType"] ?? "application/octet-stream",
                size: Int(payload["size"] ?? "0") ?? 0,
                source: .intent
            )
            receive(attachment)
            return .success(attachment.id)

        case ZodeIntent.show.rawValue:
            let raw = payload["view"] ?? AppView.nowPlaying.rawValue
            guard let view = AppView(rawValue: raw) else {
                return .failure("Unknown view '\(raw)'")
            }
            show(view)
            if let id = payload["id"] {
                if view == .collection { router.focus(albumID: id) }
                if view == .library { router.focus(trackID: id) }
            }
            return .success(raw)

        default:
            return .failure("Unsupported intent '\(intent)'")
        }
    }
}
