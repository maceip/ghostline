import AppKit
import Foundation
import WebKit

// =============================================================================
// MARK: - Contract §1 + §2 + §3 — the native bridge
// =============================================================================
//
// The web app talks to the shell through a single `WKScriptMessageHandler`
// registered under the name **`zode`** (contract §1.1 — the exact name
// matters, the web app posts to it) and receives unsolicited events through
// `window.__zodeNative__(msg)` (contract §1.1, §2.2).
//
// Every request is answered with the §1.2 envelope:
//   { "id": …, "ok": true,  "result": { … } }
//   { "id": …, "ok": false, "error": { "code": …, "message": … } }
//
// Contract §12: a request the shell does not implement must resolve with
// `{ ok: false, error: { code: "unsupported" } }` — never hang.

final class ZodeBridge: NSObject, WKScriptMessageHandler {

    /// Contract §1.1 — the script message handler name. **Do not change.**
    static let handlerName = "zode"

    // MARK: Collaborators

    weak var webView: WKWebView?

    let haptics = HapticService()
    let attachments = AttachmentService()
    let notifications = NotificationService()
    let search = SearchService()
    let journal = JournalService()
    let intents = IntentRouter()

    /// Resolves the window the bridge should drive (drag / fill-screen).
    var windowProvider: (() -> NSWindow?)?

    /// Called whenever an attachment reaches the app from outside the page
    /// (dock drop, window drop, file picker). The shell surfaces it natively
    /// as well, so an attachment is never lost (contract §2.2).
    var onAttachment: (([Attachment]) -> Void)?

    /// Called when an intent arrives from outside the app (Siri, Shortcuts,
    /// Spotlight, the Dock). The shell forwards it to the page.
    var onExternalIntent: ((String, [String: Any]) -> Void)?

    // MARK: Lifecycle

    override init() {
        super.init()
        intents.search = search
        intents.handler = { [weak self] name, payload in
            self?.applyNativeEffects(of: name, payload: payload)
        }
        notifications.onAction = { [weak self] identifier, action in
            self?.emitNotificationAction(identifier: identifier, action: action)
        }
    }

    /// Wires the bridge to its web view (called once, after the web view was
    /// created — `WKWebView` cannot be referenced from its own initialiser).
    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let request = ZodeRequest(message: message.body) else {
            // A malformed envelope cannot be answered (we do not know the id),
            // so it is dropped.
            NSLog("[Zode] dropped a malformed bridge message")
            return
        }
        handle(request)
    }

    // MARK: - Request routing (contract §3)

    private func handle(_ request: ZodeRequest) {
        let result: [String: Any]
        do {
            result = try perform(request.type, payload: request.payload)
        } catch let error as ZodeBridgeError {
            reply(ZodeEnvelope.failure(id: request.id, code: error.code, message: error.message))
            return
        } catch {
            reply(ZodeEnvelope.failure(id: request.id, code: .internalError, message: error.localizedDescription))
            return
        }
        reply(ZodeEnvelope.success(id: request.id, result: result))
    }

    private func perform(_ type: String, payload: [String: Any]) throws -> [String: Any] {
        switch type {

        // ---- haptics (contract §7) --------------------------------------
        case "haptic.play":
            guard let program = payload["program"] as? String, !program.isEmpty else {
                throw ZodeBridgeError.invalid("haptic.play requires a 'program' name.")
            }
            let loop = (payload["loop"] as? Bool) ?? false
            let played = try haptics.play(program: program, loop: loop)
            return ["program": played.program, "loop": played.loop, "engine": played.engine.rawValue]

        case "haptic.stop":
            guard let program = payload["program"] as? String, !program.isEmpty else {
                throw ZodeBridgeError.invalid("haptic.stop requires a 'program' name.")
            }
            haptics.stop(program: program)
            return [:]

        // ---- attachments (contract §8) ----------------------------------
        case "attach.pick":
            let picked = try attachments.pick()
            return ["attachments": picked.map { $0.json }]

        // ---- notifications (contract §9) --------------------------------
        case "notify.post":
            guard let title = payload["title"] as? String else {
                throw ZodeBridgeError.invalid("notify.post requires a 'title'.")
            }
            guard let body = payload["body"] as? String else {
                throw ZodeBridgeError.invalid("notify.post requires a 'body'.")
            }
            let identifier = payload["id"] as? String
            let urgency = payload["urgency"] as? String ?? "normal"
            try notifications.post(title: title, body: body, identifier: identifier, urgency: urgency)
            return [:]

        // ---- intents (contract §4) --------------------------------------
        case "intent.perform":
            guard let intent = payload["intent"] as? String, !intent.isEmpty else {
                throw ZodeBridgeError.invalid("intent.perform requires an 'intent' name.")
            }
            let intentPayload = payload["payload"] as? [String: Any] ?? [:]
            return try intents.perform(name: intent, payload: intentPayload)

        // ---- journal (contract §11) -------------------------------------
        case "journal.write":
            guard let title = payload["title"] as? String else {
                throw ZodeBridgeError.invalid("journal.write requires a 'title'.")
            }
            guard let body = payload["body"] as? String else {
                throw ZodeBridgeError.invalid("journal.write requires a 'body'.")
            }
            let date = payload["date"] as? String
            try journal.write(title: title, body: body, date: date)
            return [:]

        // ---- search (contract §10) --------------------------------------
        case "search.query":
            let query = payload["query"] as? String ?? ""
            let results = search.query(query)
            return ["results": results.map { $0.json }]

        // ---- window control (contract §5) -------------------------------
        case "window.dragStart":
            guard let screenX = (payload["screenX"] as? NSNumber)?.doubleValue,
                  let screenY = (payload["screenY"] as? NSNumber)?.doubleValue else {
                throw ZodeBridgeError.invalid("window.dragStart requires 'screenX' and 'screenY'.")
            }
            guard let window = windowProvider?() else {
                throw ZodeBridgeError.internalError("The window is not available yet.")
            }
            (window as? ZodeWindow)?.beginWindowDrag(screenX: screenX, screenY: screenY)
            return [:]

        case "window.toggleFill":
            guard let window = windowProvider?() as? ZodeWindow else {
                throw ZodeBridgeError.internalError("The window is not available yet.")
            }
            let filling = window.toggleFillScreen()
            return ["filling": filling]

        case "window.setFullScreen":
            guard let fullScreen = payload["fullScreen"] as? Bool else {
                throw ZodeBridgeError.invalid("window.setFullScreen requires a 'fullScreen' boolean.")
            }
            guard let window = windowProvider?() as? ZodeWindow else {
                throw ZodeBridgeError.internalError("The window is not available yet.")
            }
            // Contract §5: "fill" is *not* macOS full screen (which would hide
            // the menu bar and animate across Spaces) — it is the window
            // occupying the whole display.
            window.setFillingScreen(fullScreen)
            return [:]

        case "window.isFullScreen":
            guard let window = windowProvider?() as? ZodeWindow else {
                throw ZodeBridgeError.internalError("The window is not available yet.")
            }
            return ["fullScreen": window.isFillingScreen]

        // ---- misc (contract §2) -----------------------------------------
        case "app.openPath":
            guard let path = payload["path"] as? String, !path.isEmpty else {
                throw ZodeBridgeError.invalid("app.openPath requires a 'path'.")
            }
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw ZodeBridgeError.notFound("No file exists at \(url.path).")
            }
            NSWorkspace.shared.open(url)
            return [:]

        case "app.info":
            return ZodeBridge.deviceInfo()

        default:
            // Contract §12 — never hang on an unknown request.
            throw ZodeBridgeError.unsupported("The request type '\(type)' is not supported by the macOS shell.")
        }
    }

    // MARK: - Responses and events

    private func reply(_ envelope: [String: Any]) {
        guard let json = ZodeEnvelope.json(envelope) else { return }
        evaluate("window.__zodeNative__ && window.__zodeNative__(\(json));")
    }

    /// Emits one of the §2.2 events: `attachment`, `intent`, `search`,
    /// `deepLink` or `notificationAction`.
    func emit(event name: String, payload: [String: Any]) {
        guard let json = ZodeEnvelope.json(ZodeEnvelope.event(name: name, payload: payload)) else { return }
        evaluate("window.__zodeNative__ && window.__zodeNative__(\(json));")
    }

    private func evaluate(_ script: String) {
        guard let webView else { return }
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                NSLog("[Zode] bridge evaluation failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Incoming events from the operating system

    /// Contract §8 — the Dock icon drop / "Open with" hand-off.
    func deliver(attachments: [Attachment]) {
        for attachment in attachments {
            emit(event: "attachment", payload: attachment.json)
        }
        onAttachment?(attachments)
    }

    /// Contract §2 — a `zode://` deep link.
    func deliver(deepLink url: URL) {
        emit(event: "deepLink", payload: ["url": url.absoluteString])
    }

    /// Contract §4 — an intent invoked from outside the app.
    func deliver(intent name: String, payload: [String: Any]) {
        // `zode.attach` carries attachments: they are surfaced as
        // `attachment` events so the page can pick them up (contract §8).
        if name == "zode.attach", let raw = payload["attachments"] as? [[String: Any]] {
            let attachments = raw.compactMap { Attachment(json: $0) }
            if !attachments.isEmpty {
                deliver(attachments: attachments)
            }
        }
        emit(event: "intent", payload: ["intent": name, "payload": payload])
        onExternalIntent?(name, payload)
        applyNativeEffects(of: name, payload: payload)
    }

    /// The native side effects an intent has, independently of the page.
    private func applyNativeEffects(of name: String, payload: [String: Any]) {
        switch name {
        case "zode.show", "zode.agent.newTask":
            // Both intents are "open the app and do something" — bring the
            // window forward.
            NSApp.activate(ignoringOtherApps: true)
            windowProvider?()?.makeKeyAndOrderFront(nil)
        default:
            break
        }
    }

    /// Contract §10 — a query arriving from the system search UI.
    func deliver(searchQuery query: String) {
        emit(event: "search", payload: ["query": query])
    }

    private func emitNotificationAction(identifier: String, action: String) {
        emit(event: "notificationAction", payload: ["id": identifier, "action": action])
    }

    // MARK: - Device information (contract §3 `app.info`)

    static func deviceInfo() -> [String: Any] {
        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return [
            "version": version,
            "build": build,
            "platform": "macos",
            "deviceModel": ZodeBridge.hardwareModel(),
            // The web app merges these into `window.zode.capabilities`
            // (contract §2).
            "capabilities": ZodeBridge.capabilities()
        ]
    }

    /// The capability matrix of the shell (contract §2).
    ///
    /// `haptics` is only `true` when a *real* haptic engine exists — the
    /// CoreAudio fallback is not one (contract §7).
    static func capabilities() -> [String: Bool] {
        [
            "haptics": HapticService.hardwareSupportsHaptics,
            "attachments": true,
            "notifications": true,
            "intents": true,
            "journal": true,
            "search": true,
            "windowControl": true
        ]
    }

    static func hardwareModel() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafePointer(to: &info.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        return machine.isEmpty ? "unknown" : machine
    }
}
