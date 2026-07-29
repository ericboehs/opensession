import Foundation

/// Keeps the native cache of cross-device preferences current. Views continue
/// to use AppStorage so a refresh updates existing screens immediately.
@MainActor
enum NativePreferences {
    private static var generation = 0
    private static let identityKey = "os1.preferences.identity"

    static func hydrate() async {
        let config = ServerConfig.shared
        guard config.isConfigured else { return }
        let server = config.baseURLString
        let user = config.userName
        generation += 1
        let requestGeneration = generation
        guard let prefs = try? await SettingsAPI.uiPrefs(user: user) else { return }
        guard requestGeneration == generation,
              config.baseURLString == server,
              config.userName == user
        else { return }

        apply(prefs, identity: identity(server: server, user: user))
    }

    static func apply(_ prefs: [String: String]) {
        let config = ServerConfig.shared
        generation += 1
        apply(prefs, identity: identity(server: config.baseURLString, user: config.userName))
    }

    private static func apply(_ prefs: [String: String], identity: String) {
        let defaults = UserDefaults.standard
        let previousIdentity = defaults.string(forKey: identityKey)
        let changedIdentity = previousIdentity != nil && previousIdentity != identity

        set(
            prefs["default-model"],
            default: "",
            key: "os1.composer.defaultModel",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            validated(prefs["send-key"], allowed: ["enter", "mod-enter"]),
            default: "enter",
            key: "os1.composer.sendKey",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            validated(prefs["busy-send"], allowed: ["queue", "steer"]),
            default: "queue",
            key: "os1.composer.busySend",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            validated(prefs["busy-send-mod"], allowed: ["queue", "steer"]),
            default: "steer",
            key: "os1.composer.busySendMod",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            validated(prefs["turn-activity"], allowed: ["auto", "expanded", "collapsed"]),
            default: "auto",
            key: "os1.appearance.turnActivity",
            resetMissing: changedIdentity,
            in: defaults
        )
        defaults.set(identity, forKey: identityKey)
    }

    private static func identity(server: String, user: String) -> String {
        "\(server)|\(user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    private static func validated(_ value: String?, allowed: Set<String>) -> String? {
        guard let value, allowed.contains(value) else { return nil }
        return value
    }

    private static func set(
        _ value: String?,
        default defaultValue: String,
        key: String,
        resetMissing: Bool,
        in defaults: UserDefaults
    ) {
        if let value {
            defaults.set(value, forKey: key)
        } else if resetMissing {
            defaults.set(defaultValue, forKey: key)
        }
    }
}
