import Foundation

// =============================================================================
// MARK: - The bridge between the App Intents and the running shell
// =============================================================================
//
// The App Intents in this file are the macOS realisation of the contract's
// cross-platform intent names (contract §4 / §4.1). They are installed at
// launch by the app model, so an intent that is triggered by Siri, Shortcuts
// or Spotlight reaches the running app exactly like an intent the page
// triggered.

enum ZodeIntentsBridge {

    /// The library the `zode.search` intent searches.
    static var libraryProvider: (() -> [ZodeLibraryItem])?

    /// Called for every intent that is triggered from outside the app.
    static var intentHandler: ((String, [String: Any]) -> Void)?

    /// Runs the library search.
    static func search(_ query: String) -> [ZodeLibraryItem] {
        // `libraryProvider?()` is an optional, so the array has to be
        // unwrapped before it can be filtered.
        (libraryProvider?() ?? []).filter { item in
            let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !needle.isEmpty else { return true }
            if item.title.lowercased().contains(needle) { return true }
            if let subtitle = item.subtitle, subtitle.lowercased().contains(needle) { return true }
            return item.kind.rawValue.contains(needle)
        }
    }

    /// Forwards an intent to the running app.
    static func perform(_ name: String, payload: [String: Any]) {
        intentHandler?(name, payload)
    }
}
