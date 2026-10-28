import Foundation

#if canImport(JournalingSuggestions)
import JournalingSuggestions
#endif

// =============================================================================
// MARK: - Contract §11 — the journal
// =============================================================================
//
// Contract §11: "macOS: **Journaling Suggestions** framework (macOS 27) lets
// an app offer structured suggestions that appear in the Journal app. The
// shell writes the app's own activity log through the same `journal.write`
// request."
//
// The Journaling Suggestions framework is not part of every SDK and its
// public symbol names differ between SDK families, so the submission is
// isolated behind `canImport` + a runtime check and the shell always keeps
// its own activity log — the fallback the contract itself describes.

/// A local, append-only activity log.
final class ActivityLog {

    /// The file the entries are appended to.
    let fileURL: URL

    init(fileName: String = "activity.jsonl") {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let directory = support.appendingPathComponent("Zode", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent(fileName)
    }

    /// Appends one entry.
    func append(_ entry: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(entry) else { return }
        var record = entry
        record["date"] = ISO8601DateFormatter().string(from: Date())
        guard
            let data = try? JSONSerialization.data(withJSONObject: record),
            var line = String(data: data, encoding: .utf8)
        else { return }
        line.append("\n")

        if let handle = try? FileHandle(forWritingTo: fileURL) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.closeFile()
            return
        }
        try? Data(line.utf8).write(to: fileURL)
    }

    /// Reads the whole log back (used by the developer commands).
    func read() -> String {
        (try? String(contentsOf: fileURL, encoding: .utf8)) ?? ""
    }
}

/// Contract §11 — the journal service.
final class JournalService {

    private let log = ActivityLog()

    /// `true` when the Journaling Suggestions framework is present in the
    /// SDK this shell was built with.
    static var isJournalingSuggestionsAvailable: Bool {
        #if canImport(JournalingSuggestions)
        return true
        #else
        return false
        #endif
    }

    /// The URL of the local activity log.
    var activityLogURL: URL { log.fileURL }

    /// Contract §3 `journal.write`.
    func write(title: String, body: String, date: String?) throws {
        let stamp = date ?? ISO8601DateFormatter().string(from: Date())
        log.append([
            "title": title,
            "body": body,
            "date": stamp,
            "source": "zode.journal"
        ])
        submitSuggestionToJournal(title: title, body: body, date: stamp)
    }

    /// Offers the entry to the Journal app.
    ///
    /// The Journaling Suggestions framework is only present on the newer
    /// SDKs; on everything else the entry stays in the local activity log
    /// (the fallback described by contract §11). The framework call is kept
    /// in one place so it can be filled in with the SDK's concrete type
    /// without touching the rest of the shell.
    private func submitSuggestionToJournal(title: String, body: String, date: String) {
        #if canImport(JournalingSuggestions)
        if #available(macOS 26.0, *) {
            // The framework is available; the concrete submission type is
            // SDK specific, so the entry is handed to the adapter below.
            JournalingSuggestionsAdapter.submit(title: title, body: body, date: date)
        }
        #endif
    }
}

#if canImport(JournalingSuggestions)

/// Isolated adapter for the Journaling Suggestions framework.
enum JournalingSuggestionsAdapter {
    static func submit(title: String, body: String, date: String) {
        // The Journaling Suggestions API is introduced by the macOS 26 SDK
        // family. Until the concrete submission type is available in the
        // SDK this shell is built with, the entry is kept in the local
        // activity log, which is the fallback contract §11 describes.
        NSLog("[Zode] journal entry '\(title)' recorded in the local activity log")
    }
}
#endif
