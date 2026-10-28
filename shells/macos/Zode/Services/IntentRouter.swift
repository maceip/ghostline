import Foundation

// =============================================================================
// MARK: - Contract §4 — the cross-platform intent names
// =============================================================================
//
// The *names* and the *payload shapes* are what every platform must match
// (contract §4). macOS maps them onto App Intents / Shortcuts / Spotlight
// (see `Intents/ZodeIntents.swift`); the page can trigger the very same
// names through the `intent.perform` request.
//
//   zode.search          { query }
//   zode.play            { id, kind }
//   zode.pause           { }
//   zode.next            { id? }
//   zode.previous        { id? }
//   zode.agent.newTask   { prompt, attachments? }
//   zode.agent.stop      { }
//   zode.attach          { attachments }
//   zode.show            { view }

final class IntentRouter {

    /// The names the contract defines.
    static let names = [
        "zode.search",
        "zode.play",
        "zode.pause",
        "zode.next",
        "zode.previous",
        "zode.agent.newTask",
        "zode.agent.stop",
        "zode.attach",
        "zode.show"
    ]

    /// The library index, used by `zode.search`.
    var search: SearchService?

    /// Called for every intent so the running app can act on it (the page
    /// receives an `intent` event).
    var handler: ((String, [String: Any]) -> Void)?

    /// Runs an intent and returns the `IntentResult` (contract §2.1).
    ///
    /// - Throws: `ZodeBridgeError.unsupported` for an intent the shell does
    ///   not know (contract §12 — never hang).
    func perform(name: String, payload: [String: Any]) throws -> [String: Any] {
        guard IntentRouter.names.contains(name) else {
            throw ZodeBridgeError.unsupported("The intent '\(name)' is not supported by the macOS shell.")
        }

        switch name {
        case "zode.search":
            let query = (payload["query"] as? String) ?? ""
            let results = search?.query(query) ?? []
            handler?(name, payload)
            return ["ok": true, "value": ["results": results.map { $0.json }]]

        case "zode.play", "zode.pause", "zode.next", "zode.previous",
             "zode.agent.newTask", "zode.agent.stop", "zode.attach", "zode.show":
            handler?(name, payload)
            return ["ok": true]

        default:
            throw ZodeBridgeError.unsupported("The intent '\(name)' is not supported by the macOS shell.")
        }
    }
}
