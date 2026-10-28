import Foundation
import UserNotifications

// =============================================================================
// MARK: - Contract §9 — notifications
// =============================================================================
//
// macOS notifications go through `UNUserNotificationCenter` (the contract
// requires a bundled, signed app). Authorisation is requested on the first
// launch; a notification action raises an `intent` event for the page
// (contract §2.2 — the `notificationAction` event).

final class NotificationService: NSObject, UNUserNotificationCenterDelegate {

    /// The identifier of the action the shell adds to every notification.
    static let openActionIdentifier = "ZODE_OPEN"

    /// Called when the user activates a notification.
    var onAction: ((String, String) -> Void)?

    private var authorisationRequested = false

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - Authorisation

    /// Requests authorisation once per launch (contract §9).
    func requestAuthorisationIfNeeded() {
        guard !authorisationRequested else { return }
        authorisationRequested = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
                NSLog("[Zode] notification authorisation failed: \(error.localizedDescription)")
            } else {
                NSLog("[Zode] notification authorisation granted: \(granted)")
            }
        }
    }

    // MARK: - Posting

    /// Posts a local notification.
    func post(title: String, body: String, identifier: String?, urgency: String) throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.interruptionLevel = urgency == "critical" ? .critical : .active
        content.userInfo = ["id": identifier ?? ""]

        let action = UNNotificationAction(
            identifier: Self.openActionIdentifier,
            title: "Open in Zode",
            options: [.foreground]
        )
        content.categoryIdentifier = "ZODE"

        let request = UNNotificationRequest(
            identifier: identifier ?? UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                NSLog("[Zode] could not post the notification: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Show the banner even while the app is in the foreground.
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let identifier = response.notification.request.identifier
        let action = response.actionIdentifier
        onAction?(identifier, action)
        completionHandler()
    }
}
