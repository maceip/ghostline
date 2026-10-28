import AppKit
import UniformTypeIdentifiers
import WebKit

// =============================================================================
// MARK: - The web view: drop target (contract §8) + manual resize (§5)
// =============================================================================
//
// `ZodeWebView` is a `WKWebView` subclass for two reasons:
//
// 1. **Drop target.** Contract §8 requires the drop target to cover the whole
//    window — dropping anywhere, including over web content, must work.
//    AppKit asks the view under the pointer (`draggingEntered`) *before* the
//    web content sees the drag, so implementing the drag callbacks on the
//    web view itself is the robust approach. A separate overlay would have
//    to forward every mouse event to the web view and would swallow normal
//    clicks.
//
// 2. **Manual resize.** The window has no native chrome (contract §5), so
//    the invisible resize edges are implemented by hit testing here and
//    driving the window frame by hand.

final class ZodeWebView: WKWebView {

    /// Width of the invisible resize edges (contract §5 — 8 px on each edge
    /// and corner).
    static let resizeThickness: CGFloat = 8

    /// Contract §8 — called with the files that were dropped on the window.
    var onDrop: (([Attachment]) -> Void)?

    /// Contract §2 — links that must leave the app are handed to the system.
    var onOpenExternally: ((URL) -> Void)?

    /// Dev mode: the URL the shell was pointed at (if any). Used to decide
    /// whether an `http(s)` navigation is internal or external.
    private(set) var devBaseURL: URL?

    // MARK: - Construction

    init(frame: CGRect, bridge: ZodeBridge) {
        let configuration = ZodeWebView.makeConfiguration(bridge: bridge)
        super.init(frame: frame, configuration: configuration)
        bridge.attach(to: self)
        navigationDelegate = self
        uiDelegate = self
        allowsBackForwardNavigationGestures = false
        // Contract §8 — accept file drops over the whole window.
        registerForDraggedTypes([.fileURL, NSPasteboard.PasteboardType.tiff])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private static func makeConfiguration(bridge: ZodeBridge) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // On macOS there is no `allowsInlineMediaPlayback` — that one is
        // iOS only.  Here the equivalent is the list of media types that
        // need the user to start them, and an empty list means "play
        // straight away".
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.suppressesIncrementalRendering = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        // Contract §1.3 — the bundled app is served from `zode://app/`.
        configuration.setURLSchemeHandler(
            ZodeSchemeHandler(root: ZodeResources.webRoot),
            forURLScheme: ZodeSchemeHandler.scheme
        )

        // Contract §1.1 — the handler name is `zode`.
        let controller = WKUserContentController()
        controller.add(bridge, name: ZodeBridge.handlerName)
        configuration.userContentController = controller

        return configuration
    }

    // MARK: - Loading

    /// Loads the bundled web app, or the dev server when `ZODE_DEV_URL` (or
    /// the `ZodeDevURL` user default) is set (contract §1.3).
    func loadApplication() {
        if let devURL = ZodeWebView.devURL {
            devBaseURL = devURL
            load(URLRequest(url: devURL))
            return
        }
        let url = URL(string: "\(ZodeSchemeHandler.scheme)://\(ZodeSchemeHandler.host)/index.html")
            ?? ZodeResources.webRoot.appendingPathComponent("index.html")
        load(URLRequest(url: url))
    }

    /// Contract §1.3 — dev mode override.
    static var devURL: URL? {
        if let raw = ProcessInfo.processInfo.environment["ZODE_DEV_URL"], !raw.isEmpty {
            return URL(string: raw)
        }
        if let raw = UserDefaults.standard.string(forKey: "ZodeDevURL"), !raw.isEmpty {
            return URL(string: raw)
        }
        return nil
    }

    // MARK: - Manual resize (contract §5)
    //
    // The window is borderless, so AppKit's own resize affordances are gone.
    // The web view exposes invisible resize edges instead. The **top** edge
    // is deliberately excluded: it belongs to the web app's drag strip
    // (contract §5.3) and must never resize the window.

    override func hitTest(_ point: NSPoint) -> NSView? {
        if let local = localPoint(fromSuperview: point), bounds.contains(local),
           let edge = ZodeResizeEdge.edge(at: local, in: bounds, thickness: Self.resizeThickness, includesTop: false) {
            // Claim the point so the web content never sees a click that
            // belongs to a resize edge.
            return self
        }
        return super.hitTest(point)
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        for edge in ZodeResizeEdge.allCases where edge.isResizable {
            let rect = edge.rect(in: bounds, thickness: Self.resizeThickness)
            guard !rect.isEmpty else { continue }
            addCursorRect(rect, cursor: edge.cursor)
        }
    }

    override func mouseDown(with event: NSEvent) {
        if let window,
           let edge = ZodeResizeEdge.edge(at: convert(event.locationInWindow, from: nil),
                                          in: bounds,
                                          thickness: Self.resizeThickness,
                                          includesTop: false) {
            beginManualResize(edge: edge, window: window)
            return
        }
        super.mouseDown(with: event)
    }

    /// Drives the window frame by hand while the mouse is dragged.
    private func beginManualResize(edge: ZodeResizeEdge, window: NSWindow) {
        var last = NSEvent.mouseLocation
        let mask: NSEvent.EventTypeMask = [.leftMouseDragged, .leftMouseUp]
        while true {
            guard let event = window.nextEvent(matching: mask) else { break }
            if event.type == .leftMouseUp { break }
            let now = NSEvent.mouseLocation
            let delta = NSPoint(x: now.x - last.x, y: now.y - last.y)
            last = now
            var frame = window.frame
            edge.apply(delta: delta, to: &frame)
            frame.size.width = max(frame.size.width, window.minSize.width)
            frame.size.height = max(frame.size.height, window.minSize.height)
            window.setFrame(frame, display: true)
        }
    }

    private func localPoint(fromSuperview point: NSPoint) -> NSPoint? {
        guard let superview else { return nil }
        return convert(point, from: superview)
    }

    // MARK: - Drag and drop (contract §8)

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if ZodeWebView.draggingInfoCarriesFiles(sender) { return .copy }
        return super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if ZodeWebView.draggingInfoCarriesFiles(sender) { return .copy }
        return super.draggingUpdated(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        super.draggingExited(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let attachments = ZodeWebView.attachments(from: sender)
        guard !attachments.isEmpty else { return super.performDragOperation(sender) }
        onDrop?(attachments)
        return true
    }

    private static func draggingInfoCarriesFiles(_ info: NSDraggingInfo) -> Bool {
        let pasteboard = info.draggingPasteboard
        if pasteboard.types?.contains(.fileURL) == true { return true }
        if pasteboard.types?.contains(NSPasteboard.PasteboardType.tiff) == true { return true }
        return false
    }

    /// Turns a drag into `Attachment[]` with `source: "drop"`.
    private static func attachments(from info: NSDraggingInfo) -> [Attachment] {
        let pasteboard = info.draggingPasteboard
        var urls: [URL] = []
        if let objects = pasteboard.readObjects(forClasses: [NSURL.self],
                                               options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            urls.append(contentsOf: objects)
        }
        if !urls.isEmpty {
            return AttachmentService.attachments(from: urls, source: .drop)
        }
        // A dropped image (public.tiff) is written to a temporary file so it
        // can be handed to the app like any other attachment.
        if let data = pasteboard.data(forType: NSPasteboard.PasteboardType.tiff) {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("Zode-Drops", isDirectory: true)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let fileURL = directory.appendingPathComponent("drop-\(UUID().uuidString).tiff")
            if (try? data.write(to: fileURL)) != nil {
                return AttachmentService.attachments(from: [fileURL], source: .drop)
            }
        }
        return []
    }
}

// =============================================================================
// MARK: - Navigation policy
// =============================================================================
//
// * `zode://app/…`  — the bundled app: stay inside the web view.
// * `zode://…`      — a deep link: hand it to the app, do not navigate.
// * `http(s)://…`   — external unless it belongs to the dev server origin.
// * everything else  — external (system default handler).
//
// `window.open` / `target="_blank"` always goes to the default browser.

extension ZodeWebView: WKNavigationDelegate {

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        if url.scheme?.lowercased() == ZodeSchemeHandler.scheme {
            if url.host?.lowercased() == ZodeSchemeHandler.host {
                decisionHandler(.allow)          // the bundled app
            } else {
                decisionHandler(.cancel)          // `zode://collection/…` deep link
                onOpenExternally?(url)
            }
            return
        }

        if navigationAction.navigationType == .linkActivated || navigationAction.navigationType == .other {
            if isInternal(url) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                onOpenExternally?(url)
            }
            return
        }

        decisionHandler(.allow)
    }

    /// A new window request (`window.open`, `target="_blank"`) — the contract
    /// requires it to open in the system browser, never in the web view.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            onOpenExternally?(url)
        }
        return nil
    }

    private func isInternal(_ url: URL) -> Bool {
        if let devBaseURL, url.scheme == devBaseURL.scheme, url.host == devBaseURL.host {
            return true
        }
        return false
    }
}

extension ZodeWebView: WKUIDelegate {

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .informational
        alert.runModal()
        completionHandler()
    }
}
