//
//  ZodeMobileApp.swift
//  ZodeMobile
//
//  The app entry point. Wires the deep link router, the notification
//  delegate, the Spotlight index and the App Intents bridge.
//

import SwiftUI
import UserNotifications

@main
struct ZodeMobileApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .onOpenURL { url in
                    // `zode://` deep links.
                    _ = appState.intentRouter.handle(url: url)
                }
                .task {
                    appState.notifications.requestAuthorization()
                    appState.spotlight.indexAll()
                }
        }
    }
}
