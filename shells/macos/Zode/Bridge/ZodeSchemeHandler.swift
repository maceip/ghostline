import Foundation
import WebKit

// =============================================================================
// MARK: - Contract §1.3 — the `zode://app/` origin
// =============================================================================
//
// Bundled web assets are served from a custom scheme instead of `file://` so
// that the page keeps a stable, CORS-clean origin (`zode://app/index.html`).
//
// The handler resolves every request inside the bundle's `web` folder, answers
// with the right MIME type and refuses to escape the resource root.

final class ZodeSchemeHandler: NSObject, WKURLSchemeHandler {

    /// The scheme the contract mandates for macOS.
    static let scheme = "zode"

    /// The host that serves the bundled application.
    static let host = "app"

    /// The folder inside the app bundle that holds the web application.
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
        super.init()
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(ZodeSchemeError.badURL)
            return
        }
        guard url.scheme?.lowercased() == Self.scheme else {
            task.didFailWithError(ZodeSchemeError.badURL)
            return
        }

        // `zode://app/index.html` -> "/index.html"; the root serves index.html.
        var path = url.path
        if path.isEmpty || path == "/" {
            path = "/index.html"
        }
        // Percent escapes are already decoded by `URL.path`; the remaining
        // path is appended to the resource root and then checked for
        // traversal (`../../etc/passwd` must never resolve).
        let candidate = root.appendingPathComponent(path).standardizedFileURL
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else {
            task.didFailWithError(ZodeSchemeError.notFound)
            return
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else {
            task.didFailWithError(ZodeSchemeError.notFound)
            return
        }

        let fileURL: URL
        if isDirectory.boolValue {
            fileURL = candidate.appendingPathComponent("index.html")
        } else {
            fileURL = candidate
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(ZodeSchemeError.notFound)
            return
        }

        var headers: [String: String] = [
            "Content-Type": ZodeSchemeHandler.mimeType(for: fileURL.pathExtension),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        ]

        // Range requests keep `<video>`/`<audio>` seeking working.
        var body = data
        if let range = ZodeSchemeHandler.parseRange(task.request.value(forHTTPHeaderField: "Range")),
           let slice = ZodeSchemeHandler.slice(data: data, range: range) {
            body = slice
            headers["Content-Range"] = "bytes \(range.location)-\(range.location + slice.count - 1)/\(data.count)"
            headers["Content-Length"] = String(slice.count)
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )
        // The initialiser is failable, and a URL without a scheme would
        // fail it — but this is the app's own scheme handler, so the URL is
        // always well formed.
        guard let httpResponse = response else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        task.didReceive(httpResponse)
        task.didReceive(body)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Nothing to cancel: the bundled assets are read synchronously from
        // disk, so a task is always finished (or already failed) by the time
        // this callback arrives.
    }

    // MARK: - Helpers

    /// Parses a single-range `Range: bytes=start-end` header.
    private static func parseRange(_ header: String?) -> NSRange? {
        guard let header else { return nil }
        guard header.lowercased().hasPrefix("bytes=") else { return nil }
        let value = header.dropFirst("bytes=".count)
        guard let separator = value.firstIndex(of: "-") else { return nil }
        let startText = value[value.startIndex..<separator]
        let endText = value[value.index(after: separator)...]
        guard let start = Int(startText) else { return nil }
        let end = Int(endText)
        let length = (end.map { max($0 - start + 1, 1) }) ?? NSNotFound
        return NSRange(location: start, length: length)
    }

    private static func slice(data: Data, range: NSRange) -> Data? {
        guard range.location >= 0, range.location < data.count else { return nil }
        let upper = range.length == NSNotFound ? data.count : min(range.location + range.length, data.count)
        guard upper > range.location else { return nil }
        return data.subdata(in: range.location..<upper)
    }

    /// MIME types for the assets the web app ships.
    static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "map": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        case "md": return "text/markdown; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "bmp": return "image/bmp"
        case "ico": return "image/x-icon"
        case "heic": return "image/heic"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "aac": return "audio/aac"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        case "flac": return "audio/flac"
        case "mp4": return "video/mp4"
        case "m4v": return "video/mp4"
        case "webm": return "video/webm"
        case "mov": return "video/quicktime"
        case "wasm": return "application/wasm"
        case "pdf": return "application/pdf"
        default: return "application/octet-stream"
        }
    }
}

enum ZodeSchemeError: LocalizedError {
    case badURL
    case notFound

    var errorDescription: String? {
        switch self {
        case .badURL: return "The request URL could not be handled."
        case .notFound: return "The requested resource does not exist in the bundle."
        }
    }
}
