import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

@MainActor
enum NativeNotifications {
    private static let badgeCountKey = "os1.notifications.unreadBadgeCount"
    private static let badgeEnabledKey = "os1.notifications.unreadBadge"
    private static let pushAlertsKey = "os1.notifications.pushAlerts"

    static func requestAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        )) == true
        refreshBadge()
        return granted
    }

    static func requestBadgeAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.badge]
        )) == true
        refreshBadge()
        return granted
    }

    /// Keep the Home Screen and Dock icon in step with the unread session state.
    /// The badge has its own device-local switch, so it can stay on without
    /// enabling banners or sounds.
    static func syncBadgeCount(_ count: Int) {
        UserDefaults.standard.set(max(0, count), forKey: badgeCountKey)
        refreshBadge()
    }

    static func refreshBadge() {
        #if canImport(UIKit)
        let defaults = UserDefaults.standard
        let count = defaults.bool(forKey: badgeEnabledKey)
            ? defaults.integer(forKey: badgeCountKey)
            : 0
        Task {
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
        #endif
    }

    static func post(event: String, title: String, body: String) {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: pushAlertsKey),
              defaults.object(forKey: "os1.notifications.\(event)") == nil
                || defaults.bool(forKey: "os1.notifications.\(event)")
        else { return }

        let when = defaults.string(forKey: "os1.notifications.whenToNotify") ?? "background"
        guard when != "never", when == "always" || !applicationIsActive else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if defaults.string(forKey: "os1.notifications.completionSound") != "none" {
            content.sound = .default
        }
        let request = UNNotificationRequest(
            identifier: "os1-\(event)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    private static var applicationIsActive: Bool {
        #if canImport(UIKit)
        UIApplication.shared.applicationState == .active
        #else
        NSApp.isActive
        #endif
    }
}
