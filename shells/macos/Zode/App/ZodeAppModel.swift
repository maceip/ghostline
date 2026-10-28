import Combine
import Foundation
import SwiftUI

// =============================================================================
// MARK: - The observable state of the shell
// =============================================================================
//
// The model owns the bridge, the web view and the small amount of native
// state the shell shows on top of the web app (the attachment toast that
// contract §2.2 asks for).

final class ZodeAppModel: ObservableObject {

    /// The native bridge (contract §1).
    let bridge: ZodeBridge

    /// The web view that hosts the web app.
    let webView: ZodeWebView

    /// The toast that is shown when an attachment arrives from outside the
    /// page (dock drop, window drop, share sheet).
    @Published private(set) var toast: ZodeToastMessage?

    private var toastTimer: Timer?

    init(bridge: ZodeBridge, webView: ZodeWebView) {
        self.bridge = bridge
        self.webView = webView

        // Contract §2.2 — an attachment is also surfaced natively so that it
        // is never lost, even when the page has no listener yet.
        bridge.onAttachment = { [weak self] attachments in
            self?.present(attachments: attachments)
        }
    }

    // MARK: - Launch

    /// Everything that has to happen once the app is up.
    func start() {
        installIntents()
        loadLibrary()
        bridge.notifications.requestAuthorisationIfNeeded()
        webView.loadApplication()
    }

    /// Wires the App Intents to the running shell (contract §4).
    private func installIntents() {
        ZodeIntentsBridge.libraryProvider = { [weak self] in
            self?.bridge.search.items ?? []
        }
        ZodeIntentsBridge.intentHandler = { [weak self] name, payload in
            self?.bridge.deliver(intent: name, payload: payload)
        }
    }

    /// Seeds the system search index (contract §10).
    private func loadLibrary() {
        guard let url = ZodeResources.libraryURL else {
            NSLog("[Zode] no library.json found — the Spotlight index stays empty")
            return
        }
        do {
            let items = try bridge.search.loadLibrary(from: url)
            try bridge.search.index(items: items)
            NSLog("[Zode] indexed \(items.count) library item(s) in Spotlight")
        } catch {
            NSLog("[Zode] could not index the library: \(error.localizedDescription)")
        }
    }

    // MARK: - Toasts

    /// Shows the native toast for one or more attachments.
    func present(attachments: [Attachment]) {
        guard let first = attachments.first else { return }
        let title = attachments.count == 1 ? first.name : "\(attachments.count) attachments"
        let body = attachments.count == 1 ? (first.mimeType) : attachments.map { $0.name }.joined(separator: ", ")
        toast = ZodeToastMessage(title: title, body: body)

        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: false) { [weak self] _ in
            self?.toast = nil
        }
    }
}

/// A short lived native message.
struct ZodeToastMessage: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let body: String
}
