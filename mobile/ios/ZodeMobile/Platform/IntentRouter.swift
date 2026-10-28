//
//  IntentRouter.swift
//  ZodeMobile
//
//  Translates outside-the-app events -- `zode://` deep links, App Intents,
//  Spotlight actions -- into the canonical intent names from contract §4.
//
//  The names are exactly the ones the web app and the desktop shells use:
//      zode.search, zode.play, zode.pause, zode.next, zode.previous,
//      zode.agent.newTask, zode.agent.stop, zode.attach, zode.show
//

import Foundation

@MainActor
public final class IntentRouter {
    /// The app state this router drives.
    weak var appState: AppState?

    public init() {}

    // MARK: - Intents

    /// Runs a canonical intent.
    @discardableResult
    public func perform(_ intent: String, payload: [String: String] = [:]) -> IntentResult {
        guard appState != nil else {
            return .failure("No app state")
        }
        return appState?.performIntent(intent, payload: payload) ?? .failure("No app state")
    }

    /// The canonical intent names, for verification and for the App Intents.
    public static var supportedIntents: [String] {
        ZodeIntent.allCases.map(\.rawValue)
    }

    // MARK: - Deep links

    /// Handles a `zode://` URL.
    ///
    /// Supported shapes:
    ///   zode://now-playing
    ///   zode://collection
    ///   zode://collection/album/<album-id>
    ///   zode://library/track/<track-id>
    ///   zode://search?q=neon
    ///   zode://play/<kind>/<id>
    ///   zode://agent
    @discardableResult
    public func handle(url: URL) -> Bool {
        guard appState != nil else { return false }
        guard url.scheme?.lowercased() == "zode" else { return false }

        let host = url.host?.lowercased() ?? ""
        let components = url.pathComponents.filter { $0 != "/" }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let queryValue = { (name: String) -> String? in
            query.first(where: { $0.name == name })?.value
        }

        switch host {
        case "view":
            guard let raw = components.first else { return false }
            return perform(ZodeIntent.show.rawValue, payload: ["view": raw]).ok

        case "search":
            let text = queryValue("q") ?? ""
            return perform(ZodeIntent.search.rawValue, payload: ["query": text]).ok

        case "play":
            guard components.count >= 2 else { return false }
            return perform(
                ZodeIntent.play.rawValue,
                payload: ["kind": components[0], "id": components[1]]
            ).ok

        case "pause":
            return perform(ZodeIntent.pause.rawValue).ok

        case "next":
            return perform(ZodeIntent.next.rawValue).ok

        case "previous":
            return perform(ZodeIntent.previous.rawValue).ok

        case "agent":
            if components.first == "new" {
                let prompt = queryValue("prompt") ?? ""
                return perform(
                    ZodeIntent.agentNewTask.rawValue,
                    payload: ["prompt": prompt]
                ).ok
            }
            if components.first == "stop" {
                return perform(ZodeIntent.agentStop.rawValue).ok
            }
            return perform(ZodeIntent.show.rawValue, payload: ["view": AppView.agent.rawValue]).ok

        case "attach":
            let name = queryValue("name") ?? "Attachment"
            return perform(
                ZodeIntent.attach.rawValue,
                payload: ["name": name, "path": queryValue("path") ?? ""]
            ).ok

        case "collection", "library", "now-playing", "search-view":
            guard let view = AppView(rawValue: host) else { return false }
            var payload = ["view": view.rawValue]
            if host == "collection", components.count >= 2, components[0] == "album" {
                payload["id"] = components[1]
            }
            return perform(ZodeIntent.show.rawValue, payload: payload).ok

        default:
            guard let view = AppView(rawValue: host) else { return false }
            return perform(ZodeIntent.show.rawValue, payload: ["view": view.rawValue]).ok
        }
    }
}
