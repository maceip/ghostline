import AppKit
import CoreSpotlight
import SwiftUI
import UniformTypeIdentifiers

// =============================================================================
// MARK: - The application delegate
// =============================================================================
//
// The delegate owns the shell:
//   * it creates the bridge, the web view and the borderless `ZodeWindow`
//     (contract §5),
//   * it receives the Dock drops and the "Open with" hand-off (contract §8),
//   * it receives the deep links (`zode://…`, contract §2),
//   * it receives the Spotlight hand-off (contract §10).

final class AppDelegate: NSObject, NSApplicationDelegate {

    private var model: ZodeAppModel?
    private var window: ZodeWindow?

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The self test runs before the window exists, so it works headless
        // and the CI job and the release job can use it on the artifact
        // they are about to publish.
        if CommandLine.arguments.contains("--selftest") {
            let ok = SelfTest.run()
            exit(ok ? 0 : 1)
        }

        let bridge = ZodeBridge()
        let webView = ZodeWebView(frame: .zero, bridge: bridge)
        let model = ZodeAppModel(bridge: bridge, webView: webView)
        self.model = model
        ZodeAppState.bridge = bridge

        // Contract §5 — the window is a normal sized, resizable, borderless
        // window: no traffic lights, no title bar, the web content owns the
        // whole window.
        let window = ZodeWindow(contentRect: NSRect(origin: .zero, size: ZodeWindow.defaultSize))
        let hosting = NSHostingView(rootView: ZodeRootView(model: model))
        hosting.sizingOptions = []
        window.contentView = hosting
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window

        // The bridge drives the window (drag + fill screen).
        bridge.windowProvider = { [weak self] in self?.window }

        // Contract §8 — a drop on the window produces `attachment` events.
        webView.onDrop = { [weak bridge] attachments in
            bridge?.deliver(attachments: attachments)
        }

        // External links leave the app (contract §1 / §2).
        webView.onOpenExternally = { url in
            NSWorkspace.shared.open(url)
        }

        model.start()
        NSApp.activate(ignoringOtherApps: true)

        // SwiftUI may present a scene window at launch; the shell's window
        // is the only one that may be visible at start-up.
        DispatchQueue.main.async { [weak self] in
            self?.closeUnexpectedWindows()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.bridge.haptics.stopAll()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // A borderless window has to be ordered in again after the app was
        // re-activated by the Dock.
        window?.makeKeyAndOrderFront(nil)
    }

    // MARK: - Dock drops, "Open with" and deep links (contract §8 / §2)

    func application(_ application: NSApplication, open urls: [URL]) {
        handleOpen(urls: urls)
    }

    func application(_ application: NSApplication, continue userActivity: NSUserActivity) -> Bool {
        guard let bridge = model?.bridge else { return false }

        // Spotlight opened one of the items of our index.
        if userActivity.activityType == CSSearchableItemActionType {
            if let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String {
                bridge.deliver(intent: "zode.show", payload: ["item": identifier])
            }
            return true
        }

        // A search query that arrived from the system search UI.
        if let query = userActivity.userInfo?["query"] as? String {
            bridge.deliver(searchQuery: query)
            return true
        }
        return false
    }

    private func handleOpen(urls: [URL]) {
        guard let bridge = model?.bridge else { return }
        var attachments: [Attachment] = []

        for url in urls {
            if url.isFileURL {
                // Contract §8 — a drop on the Dock icon.
                attachments.append(contentsOf: AttachmentService.attachments(from: [url], source: .dock))
            } else if url.scheme?.lowercased() == "zode" {
                // Contract §2 — a deep link, e.g. `zode://collection/album/123`.
                bridge.deliver(deepLink: url)
            } else {
                NSWorkspace.shared.open(url)
            }
        }

        if !attachments.isEmpty {
            bridge.deliver(attachments: attachments)
        }
    }

    // MARK: - Windows

    /// Closes every window that is not the shell's window and was not
    /// explicitly requested by the user.
    private func closeUnexpectedWindows() {
        guard !ZodeAppState.inspectorRequested else { return }
        for candidate in NSApp.windows where !(candidate is ZodeWindow) {
            candidate.close()
        }
    }
}

// =============================================================================
// MARK: - Shared app state
// =============================================================================

/// A tiny shared state between the SwiftUI commands and the app delegate.
enum ZodeAppState {

    /// `true` when the user asked for the inspector window.
    static var inspectorRequested = false

    /// The bridge of the running shell (used by the menu commands).
    static weak var bridge: ZodeBridge?
}
