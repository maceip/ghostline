import Foundation

// =============================================================================
// MARK: - Bundled resources
// =============================================================================

enum ZodeResources {

    /// The folder inside the app bundle that holds the web application.
    ///
    /// `build.sh` copies `apps/web` into `Zode/Resources/web` before the
    /// build; the folder reference in the Xcode project copies it into
    /// `Contents/Resources/web` inside the bundle.
    static var webRoot: URL {
        (Bundle.main.resourceURL ?? URL(fileURLWithPath: "/"))
            .appendingPathComponent("web", isDirectory: true)
    }

    /// The canonical haptic programs (contract §7).
    static var hapticsURL: URL? {
        Bundle.main.url(forResource: "haptics", withExtension: "json")
    }

    /// The optional library description used to seed the system search index
    /// (contract §10).
    ///
    /// The contract's request table has no "sync the library" verb, so the
    /// shell cannot invent one. Instead it indexes the library file that the
    /// web app ships (`assets/library.json` in the canonical shape, or a flat
    /// list of items). `ZODE_LIBRARY_PATH` overrides the location.
    static var libraryURL: URL? {
        if let raw = ProcessInfo.processInfo.environment["ZODE_LIBRARY_PATH"], !raw.isEmpty {
            return URL(fileURLWithPath: raw)
        }
        let candidates = [
            webRoot.appendingPathComponent("assets/library.json"),
            webRoot.appendingPathComponent("library.json"),
            webRoot.appendingPathComponent("data/library.json"),
            webRoot.appendingPathComponent("data/library/index.json")
        ]
        return candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) })
    }
}
