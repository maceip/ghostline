import AppKit

// =============================================================================
// MARK: - The window (contract §5)
// =============================================================================
//
// Contract §5, verbatim requirements implemented here:
//
//   1. **No native window controls.** No traffic lights, no min/max/close
//      buttons, no title bar. The window shows the app's own content
//      edge-to-edge.
//   2. **The web content owns the entire window.** The shell paints no
//      background, border or shadow over the content area.
//   4. **Double-click on the drag zone fills the screen with this app
//      window** — the *entire display bounds* (not the work area), without
//      `toggleFullScreen` (which would hide the menu bar and animate across
//      Spaces).
//
// The window is a normal sized, resizable, borderless window: 1180x760 by
// default, 720x480 at the smallest. Because it is borderless, the resize
// edges are implemented by hand (see `ZodeWebView` / `ZodeResizeEdge`).

final class ZodeWindow: NSWindow {

    /// The default window size (contract §5).
    static let defaultSize = NSSize(width: 1180, height: 760)

    /// The smallest the window may become (contract §5).
    static let minimumSize = NSSize(width: 720, height: 480)

    /// True while the window occupies the whole display (contract §5.4).
    private(set) var isFillingScreen = false

    /// The frame to restore when the fill-screen state is toggled off.
    private var savedFrame: NSRect?

    /// The style mask to restore when the fill-screen state is toggled off.
    private var savedStyleMask: NSWindow.StyleMask?

    // A borderless window is not allowed to become the main window, which
    // would disable the main menu's key equivalents (Cmd-C, Cmd-V …). The
    // shell has no title bar, so there is nothing to gain from AppKit's
    // default behaviour here.
    override var canBecomeMain: Bool { true }
    override var canBecomeKey: Bool { true }

    // MARK: - Construction

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )

        // Contract §5.1 — no title bar, no traffic lights, no buttons.
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        // Contract §5.5 — the rest of the window is not draggable; only the
        // web app's drag strip may move the window, and that goes through
        // `beginWindowDrag(screenX:screenY:)`.
        isMovableByWindowBackground = false

        // Contract §5.2 — the web content owns the whole window. The window
        // background is only visible for the few milliseconds before the
        // web view paints; it matches `--zode-ink` so nothing flashes.
        backgroundColor = NSColor(srgbRed: 20.0 / 255.0, green: 20.0 / 255.0, blue: 20.0 / 255.0, alpha: 1.0)
        isOpaque = true
        hasShadow = true

        animationBehavior = .none
        isReleasedWhenClosed = false
        tabbingMode = .disallowed
        minSize = ZodeWindow.minimumSize
        setContentSize(ZodeWindow.defaultSize)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Window drag (contract §5.3)
    //
    // The web app renders the drag strip and calls
    // `zode.window.dragStart(screenX, screenY)`. The native side has to
    // perform a *real* macOS window drag: an `NSEvent` mouse-down is
    // synthesised at the pointer position, bound to this window, and handed
    // to AppKit's own drag machinery.

    /// Starts a window drag at the given screen coordinate (Cocoa screen
    /// coordinates, origin bottom-left — the same space `PointerEvent.screenX`
    /// uses).
    func beginWindowDrag(screenX: Double, screenY: Double) {
        let screenPoint = NSPoint(x: screenX, y: screenY)
        // `NSEvent.mouseEvent(with:location:…)` expects the location in the
        // window's base coordinate system, so the screen point is converted.
        let windowPoint = convertPoint(fromScreen: screenPoint)

        guard let event = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: windowPoint,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        ) else {
            performBackgroundDrag(fromScreen: screenPoint)
            return
        }

        // The cursor is hidden while the window is dragged and restored
        // afterwards (`NSCursor.hide()` / `unhide()` are balanced).
        NSCursor.hide()
        defer { NSCursor.unhide() }
        performDrag(with: event)
    }

    /// Fallback for the (rare) case where AppKit refuses the synthetic
    /// event — e.g. because the window is not yet on screen, or the session
    /// is headless.
    ///
    /// AppKit's own "movable by window background" behaviour is the
    /// documented equivalent of `NSView.mouseDownCanMoveWindow`: the window
    /// follows the pointer until the button is released. Because the web
    /// content is not draggable (contract §5.5) that behaviour cannot be
    /// triggered by the page, so the frame is driven by hand instead.
    private func performBackgroundDrag(fromScreen point: NSPoint) {
        isMovableByWindowBackground = true
        let start = NSPoint(x: point.x, y: point.y)
        let startFrame = frame
        let mask: NSEvent.EventTypeMask = [.leftMouseDragged, .leftMouseUp]
        while true {
            guard let event = nextEvent(matching: mask) else { break }
            if event.type == .leftMouseUp { break }
            let now = NSEvent.mouseLocation
            var frame = startFrame
            frame.origin.x += now.x - start.x
            frame.origin.y += now.y - start.y
            setFrame(frame, display: true)
        }
        isMovableByWindowBackground = false
    }

    // MARK: - Fill screen (contract §5.4)
    //
    // "Fill" means: the window occupies the **entire display bounds** of the
    // screen that contains the window — *not* the work area (the menu bar
    // stays visible, the window simply covers everything behind it) — and it
    // must **not** use `toggleFullScreen` (that would hide the menu bar and
    // animate the window across Spaces).

    /// Toggles the fill-screen state and returns the new state.
    @discardableResult
    func toggleFillScreen() -> Bool {
        if isFillingScreen {
            restoreFromFill()
            return false
        }
        fillScreen()
        return true
    }

    /// Explicitly sets the fill-screen state.
    func setFillingScreen(_ filling: Bool) {
        if filling == isFillingScreen { return }
        if filling {
            fillScreen()
        } else {
            restoreFromFill()
        }
    }

    private func fillScreen() {
        guard let screen = currentScreen() else { return }

        savedFrame = frame
        savedStyleMask = styleMask

        // The *whole* display, not `visibleFrame`.
        setFrame(screen.frame, display: true)

        // No title bar while the window is filled.
        var mask = styleMask
        mask.remove(.titled)
        styleMask = mask

        isFillingScreen = true
    }

    private func restoreFromFill() {
        if let frame = savedFrame {
            setFrame(frame, display: true)
        }
        if let mask = savedStyleMask {
            var restored = mask
            // The saved mask is the shell's normal mask, which — per
            // contract §5.1 — never contains `.titled`: the window has no
            // title bar at all. Restoring it therefore never re-introduces a
            // title bar; the line below only guards against a mask that was
            // saved with `.titled` set by something else.
            restored.remove(.titled)
            styleMask = restored
        }
        savedFrame = nil
        savedStyleMask = nil
        isFillingScreen = false
    }

    /// The screen that currently holds the window (contract §5.4).
    func currentScreen() -> NSScreen? {
        NSScreen.screens.first(where: { $0.frame.intersects(frame) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }
}
