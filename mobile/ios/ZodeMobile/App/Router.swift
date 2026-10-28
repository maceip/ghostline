//
//  Router.swift
//  ZodeMobile
//
//  The app's navigation state. The five views match contract §4's `zode.show`
//  payload values exactly (`now-playing`, `collection`, `library`, `search`,
//  `agent`).
//

import Combine
import Foundation

@MainActor
public final class Router: ObservableObject {
    /// The current view.
    @Published public var view: AppView = .nowPlaying

    /// The album the Collection view should scroll to.
    @Published public var focusedAlbumID: String?

    /// The track the Library view should scroll to.
    @Published public var focusedTrackID: String?

    /// A search query pushed from outside the app (Spotlight, App Intents).
    @Published public var incomingSearch: String?

    /// A play request pushed from outside the app.
    @Published public var incomingPlay: PlayableItem?

    public init() {}

    public func show(_ view: AppView) {
        self.view = view
    }

    public func focus(albumID: String?) {
        focusedAlbumID = albumID
    }

    public func focus(trackID: String?) {
        focusedTrackID = trackID
    }

    /// Handles a `zode://` deep link. Returns true when the link was understood.
    public func handle(url: URL) -> Bool {
        guard url.scheme?.lowercased() == "zode" else { return false }

        // `zode://collection/album/album-00` -> host "collection", path
        // "/album/album-00".
        let host = url.host?.lowercased() ?? ""
        let components = url.pathComponents.filter { $0 != "/" }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []

        switch host {
        case "view":
            guard let raw = components.first, let view = AppView(rawValue: raw) else { return false }
            self.view = view
            return true

        case "search":
            self.view = .search
            if let text = query.first(where: { $0.name == "q" })?.value {
                incomingSearch = text
            }
            return true

        case "play":
            guard components.count >= 2 else { return false }
            incomingPlay = PlayableItem.parse(kind: components[0], id: components[1])
            return true

        case "agent":
            self.view = .agent
            return true

        case "collection":
            self.view = .collection
            if components.count >= 2, components[0] == "album" {
                focusedAlbumID = components[1]
            }
            return true

        case "library":
            self.view = .library
            if components.count >= 2, components[0] == "track" {
                focusedTrackID = components[1]
            }
            return true

        case "now-playing":
            self.view = .nowPlaying
            return true

        default:
            // `zode://collection` and friends -- treat the host as a view name.
            if let view = AppView(rawValue: host) {
                self.view = view
                return true
            }
            return false
        }
    }
}
