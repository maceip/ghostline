import AppKit
import SwiftUI

// =============================================================================
// MARK: - The menu bar
// =============================================================================

struct ZodeCommands: Commands {

    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        // Contract §8 — the native file picker is also reachable from the
        // menu, not only from the page.
        CommandGroup(after: .newItem) {
            Button("Attach Files…") {
                ZodeCommands.pickAttachments()
            }
            .keyboardShortcut("o", modifiers: .command)

            Button("Inspector…") {
                ZodeAppState.inspectorRequested = true
                openWindow(id: "inspector")
            }
        }

        CommandGroup(replacing: .help) {
            // The developer check that proves the JSON of
            // `packages/shared/haptics.json` is mapped onto CoreHaptics
            // parameters correctly — on any machine, without a device.
            Button("Verify Haptic Programs") {
                ZodeCommands.verifyHapticPrograms()
            }
        }
    }

    // MARK: - Actions

    /// Shows the native file picker and hands the files to the app.
    static func pickAttachments() {
        guard let bridge = ZodeAppState.bridge else { return }
        do {
            let attachments = try bridge.attachments.pick()
            bridge.deliver(attachments: attachments)
        } catch ZodeBridgeError.cancelled {
            // The user dismissed the panel — nothing to do.
        } catch {
            let alert = NSAlert()
            alert.messageText = "The files could not be attached."
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.runModal()
        }
    }

    /// Prints the computed haptic patterns.
    static func verifyHapticPrograms() {
        guard let bridge = ZodeAppState.bridge else { return }
        var text = "Haptic programs (packages/shared/haptics.json)\n\n"
        for name in bridge.haptics.availablePrograms {
            text += (bridge.haptics.describe(program: name) ?? "—") + "\n\n"
        }
        text += "Engine: "
        text += HapticService.hardwareSupportsHaptics ? "CoreHaptics (real haptic engine)" : "CoreAudio sine synthesiser (fallback)"

        let alert = NSAlert()
        alert.messageText = "Haptic programs"
        alert.informativeText = text
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Copy")
        alert.addButton(withTitle: "OK")
        if alert.runModal() == .alertFirstButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }
}
