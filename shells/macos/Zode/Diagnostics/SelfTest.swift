import Foundation

// =============================================================================
// MARK: - The self test
// =============================================================================
//
// A release once shipped a bare executable that downloaded fine and then did
// nothing, because the resources it needed were not next to it.  So the
// shell can be asked to prove itself:
//
//     Zode.app/Contents/MacOS/Zode --selftest
//
// It resolves its resources the same way the app does — no test-only path —
// prints one line per check and exits 0 when everything is there.
//
// It needs no window, no webview and no display, so the CI job and the
// release job can run it on the artifact they are about to publish.

enum SelfTest {

    /// Runs the checks. Returns `true` when the shell is whole.
    static func run() -> Bool {
        var failures: [String] = []

        @discardableResult
        func check(_ name: String, _ ok: Bool, _ detail: String = "") -> Bool {
            if ok {
                print("  ok   \(name)")
            } else {
                print("  FAIL \(name) — \(detail)")
                failures.append(name)
            }
            return ok
        }

        print("Zode shell self test")

        // 1. Where the shell thinks it is.
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let baseDirectory = executable.deletingLastPathComponent()
        print("  executable: \(executable.path)")

        // 2. The web app, resolved the way the app resolves it.
        let bundleResources = Bundle.main.resourceURL
        guard let webRoot = bundleResources?.appendingPathComponent("web", isDirectory: true) else {
            check("the app bundle has a Resources folder", false,
                  "Bundle.main.resourceURL is nil")
            return finish(failures)
        }

        check("the web folder is in the bundle", FileManager.default.fileExists(atPath: webRoot.path),
              webRoot.path)

        let index = webRoot.appendingPathComponent("index.html")
        if check("web/index.html exists", FileManager.default.fileExists(atPath: index.path),
                 index.path) {
            let html = (try? String(contentsOf: index, encoding: .utf8)) ?? ""
            // The placeholder the shell writes when the web app is missing
            // must not be mistaken for the real thing.
            check("web/index.html is the real app, not the placeholder",
                  (html.contains("zode-root") || html.contains("id=\"root\""))
                  && !html.contains("The web app is missing"))
        }

        let assetsDir = webRoot.appendingPathComponent("assets", isDirectory: true)
        let assetFiles = (try? FileManager.default.contentsOfDirectory(atPath: assetsDir.path)) ?? []
        check("web/assets has compiled JS bundle",
              assetFiles.contains(where: { $0.hasSuffix(".js") })
              || FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("src/main.js").path))
        check("web/zode-mark.svg exists",
              FileManager.default.fileExists(
                  atPath: webRoot.appendingPathComponent("zode-mark.svg").path))
        check("web/assets/tokens.css exists",
              FileManager.default.fileExists(
                  atPath: webRoot.appendingPathComponent("assets/tokens.css").path))

        // 3. The shared contract data has to be valid JSON.
        let haptics = webRoot.appendingPathComponent("assets/haptics.json")
        if check("web/assets/haptics.json exists",
                 FileManager.default.fileExists(atPath: haptics.path), haptics.path) {
            if let data = try? Data(contentsOf: haptics),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let programs = json["programs"] as? [String: Any] {
                check("haptics.json has the 'done' program", programs["done"] != nil)
                check("haptics.json has the 'working' program", programs["working"] != nil)
            } else {
                check("haptics.json parses", false)
            }
        }

        let library = webRoot.appendingPathComponent("assets/library.json")
        if check("web/assets/library.json exists",
                 FileManager.default.fileExists(atPath: library.path), library.path) {
            if let data = try? Data(contentsOf: library),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tracks = json["tracks"] as? [[String: Any]] {
                check("library.json has tracks", !tracks.isEmpty, "\(tracks.count) tracks")
            } else {
                check("library.json parses", false)
            }
        }

        return finish(failures)
    }

    private static func finish(_ failures: [String]) -> Bool {
        print("")
        if failures.isEmpty {
            print("SELFTEST PASSED — the shell can start and finds its resources.")
            return true
        }

        print("SELFTEST FAILED — \(failures.count) check(s) did not pass:")
        for failure in failures {
            print("  - \(failure)")
        }
        print("")
        print("If the web folder is missing, the app was packaged without it.")
        return false
    }
}
