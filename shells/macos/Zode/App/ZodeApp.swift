import SwiftUI

// =============================================================================
// MARK: - The app entry point
// =============================================================================
//
// Contract §5 forbids *any* native window chrome: no title bar, no traffic
// lights, no minimise/maximise/close buttons. SwiftUI's `WindowGroup` always
// installs an `NSTitlebarContainerView` with traffic lights, so the visible
// window is the AppKit `ZodeWindow` (an `NSWindow` subclass) that the app
// delegate creates and hosts with SwiftUI through `NSHostingView`.
//
// The scenes below own the menu bar, the commands and the app lifecycle.
// The `WindowGroup` is the on-demand *Inspector* window — it is closed again
// at launch, the shell's own window is the only window the user sees.

@main
struct ZodeApp: App {

    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            ZodeSettingsView()
        }

        WindowGroup(id: "inspector") {
            ZodeInspectorView()
        }
        .defaultSize(width: 460, height: 280)
        .commands {
            ZodeCommands()
        }
    }
}
