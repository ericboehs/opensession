import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

@MainActor
enum NativeNotifications {
    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        )) == true
    }

    static func post(event: String, title: String, body: String) {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "os1.notifications.pushAlerts"),
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
