//
//  NotificationSupport.swift
//  ZodeMobile
//
//  Local notifications (contract §9). The iOS app posts a notification when an
//  agent task finishes, and handles the two notification actions.
//

import Combine
import Foundation
import UserNotifications

@MainActor
public final class NotificationSupport: ObservableObject {
    /// The category used for the agent notifications.
    public static let categoryIdentifier = "zode.agent"

    /// The action identifiers.
    public enum Action: String {
        case open = "zode.open"
        case play = "zode.play"
        case agent = "zode.agent"
    }

    /// Called when the user taps a notification action.
    public var onAction: ((String, String) -> Void)?

    @Published public private(set) var isAuthorized = false

    private var cancellables: Set<AnyCancellable> = []

    public init() {
        NotificationCenter.default.publisher(for: .zodeNotificationAction)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in
                guard let self,
                      let info = note.userInfo,
                      let id = info["id"] as? String,
                      let action = info["action"] as? String else { return }
                self.onAction?(id, action)
            }
            .store(in: &cancellables)
    }

    /// Asks for permission and registers the notification category.
    public func requestAuthorization() {
        let center = UNUserNotificationCenter.current()
        center.delegate = NotificationDelegate.shared
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.categoryIdentifier,
                actions: [
                    UNNotificationAction(identifier: Action.play.rawValue, title: "Play"),
                    UNNotificationAction(identifier: Action.agent.rawValue, title: "Open agent"),
                ],
                intentIdentifiers: [],
                options: []
            )
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            Task { @MainActor in
                self?.isAuthorized = granted
            }
        }
    }

    /// Posts a local notification. `urgency` maps onto the interruption level.
    public func post(title: String, body: String, id: String? = nil, urgency: String = "normal") {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = urgency == "critical" ? .defaultCritical : .default
        if #available(iOS 15.0, *) {
            content.interruptionLevel = urgency == "critical" ? .critical : .active
        }

        let request = UNNotificationRequest(
            identifier: id ?? "zode-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

/// Routes notification taps into the app.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        var payload = userInfo
        payload["action"] = response.actionIdentifier
        payload["id"] = userInfo["id"] as? String ?? response.notification.request.identifier
        NotificationCenter.default.post(name: .zodeNotificationAction, object: nil, userInfo: payload)
        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }
}

public extension Notification.Name {
    /// Posted when a notification action is triggered.
    static let zodeNotificationAction = Notification.Name("com.zode.app.notificationAction")
}
