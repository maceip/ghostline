import Foundation

// =============================================================================
// MARK: - Contract §2.1 / §8 — attachments
// =============================================================================

/// A file handed to the app.
struct Attachment: Equatable {

    /// Where the attachment came from (contract §2.1).
    enum Source: String {
        case dock
        case drop
        case picker
        case share
        case intent

        var rawValue: String { rawValue }
    }

    /// A stable id for this session.
    let id: String
    /// The file name.
    let name: String
    /// The absolute path on disk.
    let path: String
    /// Best effort MIME type, e.g. `image/png`.
    let mimeType: String
    /// The size in bytes.
    let size: Int64
    /// The origin of the attachment.
    let source: Source

    /// Builds an attachment.
    ///
    /// This has to be written out: the `init?(json:)` below suppresses the
    /// memberwise initialiser that Swift would otherwise synthesise.
    init(id: String, name: String, path: String, mimeType: String, size: Int64, source: Source) {
        self.id = id
        self.name = name
        self.path = path
        self.mimeType = mimeType
        self.size = size
        self.source = source
    }

    /// The JSON representation used on the wire (contract §2.1).
    var json: [String: Any] {
        [
            "id": id,
            "name": name,
            "path": path,
            "mimeType": mimeType,
            "size": size,
            "source": source.rawValue
        ]
    }

    /// Reads an attachment back from the wire format.
    init?(json: [String: Any]) {
        guard let id = json["id"] as? String,
              let name = json["name"] as? String,
              let path = json["path"] as? String else { return nil }
        let mimeType = (json["mimeType"] as? String) ?? "application/octet-stream"
        let size = (json["size"] as? NSNumber)?.int64Value ?? 0
        let source = Source(rawValue: (json["source"] as? String) ?? "") ?? .intent
        self.id = id
        self.name = name
        self.path = path
        self.mimeType = mimeType
        self.size = size
        self.source = source
    }
}
