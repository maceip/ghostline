import SwiftUI
import WebKit

// =============================================================================
// MARK: - The web view in SwiftUI
// =============================================================================

/// Hosts the `ZodeWebView` inside the SwiftUI hierarchy.
///
/// The web view is created by the app delegate (it needs the bridge, the
/// scheme handler and the script message handler) and is simply handed to
/// SwiftUI here.
struct ZodeWebViewRepresentable: NSViewRepresentable {

    let webView: ZodeWebView

    func makeNSView(context: Context) -> ZodeWebView {
        webView
    }

    func updateNSView(_ nsView: ZodeWebView, context: Context) {
        // The web view is owned by the app delegate; SwiftUI only hosts it.
    }
}

// =============================================================================
// MARK: - The root view
// =============================================================================

/// The SwiftUI shell: the web app fills the window, the native toast is
/// drawn on top of it.
struct ZodeRootView: View {

    @ObservedObject var model: ZodeAppModel

    var body: some View {
        ZodeWebViewRepresentable(webView: model.webView)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottomTrailing) {
                if let toast = model.toast {
                    ZodeToastView(message: toast)
                        .allowsHitTesting(false)
                        .padding(20)
                        .transition(.opacity)
                }
            }
            .background(Color(nsColor: NSColor(
                srgbRed: 20.0 / 255.0,
                green: 20.0 / 255.0,
                blue: 20.0 / 255.0,
                alpha: 1.0
            )))
    }
}

// =============================================================================
// MARK: - The native toast
// =============================================================================

/// A small Metro styled panel that confirms an attachment arrived.
///
/// The colours come from `packages/shared/tokens.css`:
///
///   --zode-ink-2     #1f1f1f   the raised card
///   --zode-orange    #ff4e00   the brand accent
///   --zode-text-invert #f7f5f2 the text
struct ZodeToastView: View {

    let message: ZodeToastMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(message.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(Color(nsColor: NSColor(srgbRed: 0.973, green: 0.961, blue: 0.949, alpha: 1)))
            Text(message.body)
                .font(.system(size: 11))
                .foregroundColor(Color(nsColor: NSColor(srgbRed: 0.604, green: 0.588, blue: 0.561, alpha: 1)))
                .lineLimit(2)
        }
        .padding(12)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Color(nsColor: NSColor(srgbRed: 0.122, green: 0.122, blue: 0.122, alpha: 0.96)))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color(nsColor: NSColor(srgbRed: 1.0, green: 0.306, blue: 0.0, alpha: 1)))
                .frame(width: 3)
        }
        .clipShape(Rectangle())
    }
}

// =============================================================================
// MARK: - The auxiliary panels
// =============================================================================

/// The Settings scene of the app.
struct ZodeSettingsView: View {
    var body: some View {
        Form {
            Section("Zode") {
                LabeledContent("Version", value: ZodeBridge.deviceInfo()["version"] as? String ?? "0")
                LabeledContent("Build", value: ZodeBridge.deviceInfo()["build"] as? String ?? "0")
                LabeledContent("Platform", value: "macos")
                LabeledContent("Model", value: ZodeBridge.hardwareModel())
            }
        }
        .formStyle(.grouped)
        .frame(width: 380, height: 220)
    }
}

/// The developer inspector: what the shell can do right now.
struct ZodeInspectorView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Zode Inspector")
                .font(.system(size: 20, weight: .light))
            Text("The macOS shell hosts the Zune/Metro web app in a WKWebView.")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            LabeledContent("Bridge handler", value: ZodeBridge.handlerName)
            LabeledContent("Origin", value: "\(ZodeSchemeHandler.scheme)://\(ZodeSchemeHandler.host)/")
            LabeledContent("Haptic engine", value: HapticService.hardwareSupportsHaptics ? "CoreHaptics" : "CoreAudio (fallback)")
            LabeledContent("Notifications", value: "UNUserNotificationCenter")
            LabeledContent("Search", value: "CoreSpotlight")
        }
        .padding(20)
        .frame(width: 460, height: 280)
    }
}
