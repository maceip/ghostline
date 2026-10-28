//
//  Models.swift
//  ZodeMobile
//
//  The data model shared by the iOS app, the Android app and the web app.
//  Shapes mirror contract §2.1 (`Attachment`, `IntentResult`, `SearchResult`)
//  and the library entities seeded by `Data/Library.swift`.
//

import Foundation

// MARK: - Library entities

/// A performing artist.
public struct Artist: Identifiable, Hashable, Codable, Sendable {
    public let id: String
    public let name: String
    public let genre: String
    public let albumIDs: [String]

    public init(id: String, name: String, genre: String, albumIDs: [String]) {
        self.id = id
        self.name = name
        self.genre = genre
        self.albumIDs = albumIDs
    }
}

/// An album. `accentHex` drives the flat Metro tile colour.
public struct Album: Identifiable, Hashable, Codable, Sendable {
    public let id: String
    public let title: String
    public let artistID: String
    public let year: Int
    public let genre: String
    public let trackIDs: [String]
    public let accentHex: UInt32

    public init(
        id: String,
        title: String,
        artistID: String,
        year: Int,
        genre: String,
        trackIDs: [String],
        accentHex: UInt32
    ) {
        self.id = id
        self.title = title
        self.artistID = artistID
        self.year = year
        self.genre = genre
        self.trackIDs = trackIDs
        self.accentHex = accentHex
    }
}

/// A single track.
public struct Track: Identifiable, Hashable, Codable, Sendable {
    public let id: String
    public let title: String
    public let artistID: String
    public let albumID: String
    public let durationSeconds: Int
    public let trackNumber: Int
    public let year: Int
    public let genre: String

    public init(
        id: String,
        title: String,
        artistID: String,
        albumID: String,
        durationSeconds: Int,
        trackNumber: Int,
        year: Int,
        genre: String
    ) {
        self.id = id
        self.title = title
        self.artistID = artistID
        self.albumID = albumID
        self.durationSeconds = durationSeconds
        self.trackNumber = trackNumber
        self.year = year
        self.genre = genre
    }

    /// `m:ss` — the format used by the Library and Now Playing views.
    public var durationLabel: String {
        let minutes = durationSeconds / 60
        let seconds = durationSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

/// A user-curated playlist.
public struct Playlist: Identifiable, Hashable, Codable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let trackIDs: [String]

    public init(id: String, title: String, subtitle: String, trackIDs: [String]) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.trackIDs = trackIDs
    }
}

// MARK: - Attachments (contract §2.1)

/// A file handed to the app. Matches the contract's `Attachment` shape.
public struct Attachment: Identifiable, Hashable, Codable, Sendable {
    public enum Source: String, Codable, Sendable, CaseIterable {
        case dock
        case drop
        case picker
        case share
        case intent
    }

    public let id: String
    public let name: String
    public let path: String
    public let mimeType: String
    public let size: Int
    public let source: Source

    public init(
        id: String,
        name: String,
        path: String,
        mimeType: String,
        size: Int,
        source: Source
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.mimeType = mimeType
        self.size = size
        self.source = source
    }

    /// Best-effort size label, e.g. `1.2 MB`.
    public var sizeLabel: String {
        let bytes = Double(size)
        if bytes < 1024 { return "\(size) B" }
        if bytes < 1024 * 1024 { return String(format: "%.0f KB", bytes / 1024) }
        return String(format: "%.1f MB", bytes / (1024 * 1024))
    }
}

// MARK: - Agent tasks

/// A message inside an agent task's transcript.
public struct AgentMessage: Identifiable, Hashable, Codable, Sendable {
    public enum Role: String, Codable, Sendable {
        case user
        case agent
        case system
    }

    public let id: String
    public let role: Role
    public let text: String
    public let at: Date

    public init(id: String, role: Role, text: String, at: Date) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
    }
}

/// An agent task, mirroring the web app's task lifecycle.
public struct AgentTask: Identifiable, Hashable, Codable, Sendable {
    public enum State: String, Codable, Sendable {
        case pending
        case running
        case done
        case failed
        case stopped
    }

    public let id: String
    public var prompt: String
    public var state: State
    public var progress: Double
    public var messages: [AgentMessage]
    public var attachments: [Attachment]
    public var startedAt: Date
    public var finishedAt: Date?

    public init(
        id: String,
        prompt: String,
        state: State = .pending,
        progress: Double = 0,
        messages: [AgentMessage] = [],
        attachments: [Attachment] = [],
        startedAt: Date = Date(),
        finishedAt: Date? = nil
    ) {
        self.id = id
        self.prompt = prompt
        self.state = state
        self.progress = progress
        self.messages = messages
        self.attachments = attachments
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }

    public var isRunning: Bool { state == .running }
}

// MARK: - Search (contract §2.1)

/// One search hit. The `kind` values match contract §2.1 exactly.
public struct SearchResult: Identifiable, Hashable, Codable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case track
        case album
        case artist
        case playlist
        case task
        case file
        case action
    }

    public let id: String
    public let title: String
    public let subtitle: String?
    public let kind: Kind
    public let payload: [String: String]

    public init(
        id: String,
        title: String,
        subtitle: String? = nil,
        kind: Kind,
        payload: [String: String] = [:]
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
        self.payload = payload
    }
}

// MARK: - Intents (contract §4)

/// The result of running an intent. Matches the contract's `IntentResult`.
public struct IntentResult: Hashable, Codable, Sendable {
    public let ok: Bool
    public let value: String?
    public let message: String?

    public init(ok: Bool, value: String? = nil, message: String? = nil) {
        self.ok = ok
        self.value = value
        self.message = message
    }

    public static func success(_ value: String? = nil) -> IntentResult {
        IntentResult(ok: true, value: value)
    }

    public static func failure(_ message: String) -> IntentResult {
        IntentResult(ok: false, message: message)
    }
}

/// The canonical intent names from contract §4. Every platform uses these
/// exact strings.
public enum ZodeIntent: String, CaseIterable, Codable, Sendable {
    case search = "zode.search"
    case play = "zode.play"
    case pause = "zode.pause"
    case next = "zode.next"
    case previous = "zode.previous"
    case agentNewTask = "zode.agent.newTask"
    case agentStop = "zode.agent.stop"
    case attach = "zode.attach"
    case show = "zode.show"

    /// The `view` values accepted by `zode.show`.
    public static let views: [String] = [
        "now-playing", "collection", "library", "search", "agent",
    ]
}

/// The payload of an intent invocation.
public struct IntentPayload: Hashable, Codable, Sendable {
    public let intent: String
    public let values: [String: String]

    public init(intent: String, values: [String: String] = [:]) {
        self.intent = intent
        self.values = values
    }

    public func string(_ key: String) -> String? {
        values[key]
    }
}

// MARK: - Navigation

/// The five views. The raw values match the `zode.show` payload in §4.
public enum AppView: String, CaseIterable, Identifiable, Codable, Sendable {
    case nowPlaying = "now-playing"
    case collection = "collection"
    case library = "library"
    case search = "search"
    case agent = "agent"

    public var id: String { rawValue }

    /// The uppercase tracked label used in the Metro rail.
    public var label: String {
        switch self {
        case .nowPlaying: return "NOW"
        case .collection: return "COLLECTION"
        case .library: return "LIBRARY"
        case .search: return "SEARCH"
        case .agent: return "AGENT"
        }
    }

    /// SF Symbol used by the rail tile.
    public var glyph: String {
        switch self {
        case .nowPlaying: return "play.rectangle"
        case .collection: return "square.grid.2x2"
        case .library: return "list.bullet"
        case .search: return "magnifyingglass"
        case .agent: return "sparkles"
        }
    }

    /// The order of the rail, left to right.
    public static let railOrder: [AppView] = [.nowPlaying, .collection, .library, .search, .agent]
}

// MARK: - Playback

/// A thing that can be played.
public enum PlayableItem: Hashable, Codable, Sendable {
    case track(String)
    case album(String)
    case artist(String)
    case playlist(String)

    /// The `kind` string used by the `zode.play` payload.
    public var kind: String {
        switch self {
        case .track: return "track"
        case .album: return "album"
        case .artist: return "artist"
        case .playlist: return "playlist"
        }
    }

    public var id: String {
        switch self {
        case .track(let id), .album(let id), .artist(let id), .playlist(let id):
            return id
        }
    }

    /// Parses the `kind`/`id` pair carried by `zode.play`.
    public static func parse(kind: String, id: String) -> PlayableItem? {
        switch kind {
        case "track": return .track(id)
        case "album": return .album(id)
        case "artist": return .artist(id)
        case "playlist": return .playlist(id)
        default: return nil
        }
    }
}

/// The transport state shared by the Now Playing view and the intents.
public struct PlaybackState: Hashable, Codable, Sendable {
    public var currentTrackID: String?
    public var isPlaying: Bool
    public var elapsed: TimeInterval

    public init(currentTrackID: String? = nil, isPlaying: Bool = false, elapsed: TimeInterval = 0) {
        self.currentTrackID = currentTrackID
        self.isPlaying = isPlaying
        self.elapsed = elapsed
    }
}
