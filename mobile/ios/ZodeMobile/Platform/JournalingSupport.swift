//
//  JournalingSupport.swift
//  ZodeMobile
//
//  Contract §11. The macOS shell offers structured suggestions to the system
//  Journal app; iOS has no equivalent API, so the app keeps its own activity
//  log and reports `capabilities.journal = false` honestly.
//
//  The log is a plain text file in the app's Application Support directory.
//

import Foundation

public final class JournalingSupport {
    /// One journal entry.
    public struct Entry: Codable, Hashable, Sendable {
        public let title: String
        public let body: String
        public let date: Date

        public init(title: String, body: String, date: Date = Date()) {
            self.title = title
            self.body = body
            self.date = date
        }
    }

    /// The log file.
    public let fileURL: URL?

    /// The entries written so far (newest last).
    public private(set) var entries: [Entry] = []

    public init(fileURL: URL? = JournalingSupport.defaultFileURL()) {
        self.fileURL = fileURL
        load()
    }

    /// `journal.write` from contract §3. Always succeeds on iOS -- the entry
    /// lands in the local activity log.
    @discardableResult
    public func write(title: String, body: String, date: Date = Date()) -> Bool {
        let entry = Entry(title: title, body: body, date: date)
        entries.append(entry)
        return persist(entry)
    }

    /// The default log location: `Application Support/journal.log`.
    public static func defaultFileURL() -> URL? {
        let manager = FileManager.default
        guard let base = try? manager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        return base.appendingPathComponent("zode-journal.log")
    }

    private func persist(_ entry: Entry) -> Bool {
        guard let fileURL else { return false }
        let formatter = ISO8601DateFormatter()
        let line = "\(formatter.string(from: entry.date))\t\(entry.title)\t\(entry.body)\n"
        do {
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(line.utf8))
            return true
        } catch {
            // Create the file if it does not exist yet, then retry once.
            guard FileManager.default.createFile(atPath: fileURL.path, contents: nil) else {
                return false
            }
            return persist(entry)
        }
    }

    private func load() {
        guard let fileURL,
              let contents = try? String(contentsOf: fileURL, encoding: .utf8) else { return }
        let formatter = ISO8601DateFormatter()
        entries = contents.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3 else { return nil }
            let date = formatter.date(from: String(parts[0])) ?? Date()
            return Entry(title: String(parts[1]), body: String(parts[2]), date: date)
        }
    }
}
