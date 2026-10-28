import AppKit
import Foundation
import UniformTypeIdentifiers

// =============================================================================
// MARK: - Contract §8 — the file picker, the drop and the dock
// =============================================================================

final class AttachmentService {

    /// Contract §3 `attach.pick` — shows the native file picker.
    ///
    /// Must be called on the main thread (the script message handler is).
    func pick() throws -> [Attachment] {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = true
        panel.prompt = "Attach"
        panel.message = "Choose the files Zode should work with."

        let response = panel.runModal()
        guard response == .OK else {
            throw ZodeBridgeError.cancelled("The file picker was dismissed.")
        }
        return AttachmentService.attachments(from: panel.urls, source: .picker)
    }

    /// Builds attachments out of a list of URLs.
    static func attachments(from urls: [URL], source: Attachment.Source) -> [Attachment] {
        urls.map { url in
            let resolved = url.standardizedFileURL
            let attributes = try? FileManager.default.attributesOfItem(atPath: resolved.path)
            let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
            return Attachment(
                id: UUID().uuidString,
                name: resolved.lastPathComponent,
                path: resolved.path,
                mimeType: mimeType(for: resolved),
                size: size,
                source: source
            )
        }
    }

    /// Best effort MIME type via `UTType` (contract §2.1).
    static func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension), let mime = type.preferredMIMEType {
            return mime
        }
        // A file without an extension: fall back to the resource value.
        if let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType,
           let mime = type.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }
}
