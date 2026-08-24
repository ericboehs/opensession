import Foundation

/// Keeps the native cache of cross-device preferences current. Views continue
/// to use AppStorage so a refresh updates existing screens immediately.
@MainActor
enum NativePreferences {
    struct Context: Equatable {
        let server: String
        let user: String
        let login: String
        fileprivate let token: String
    }

    private static var generation = 0
    private static var pendingLocalWrites = 0
    private static var recentModelsWriteTail: Task<Void, Never>?
    private static let identityKey = "os1.preferences.identity"
    private static let bucketKey = "os1.preferences.bucket"
    static let recentModelsStorageKey = "os1.composer.recentModels"
    static let recentModelsPrefKey = "recent-models"
    static let recentModelLimit = 12
    static let recentModelDisplayLimit = 3

    static func context() -> Context {
        let config = ServerConfig.shared
        return Context(
            server: config.baseURLString,
            user: config.userName,
            login: config.githubLogin,
            token: config.token
        )
    }

    static func hydrate() async {
        let config = ServerConfig.shared
        guard config.isConfigured, pendingLocalWrites == 0 else { return }
        let requestContext = context()
        generation += 1
        let requestGeneration = generation
        guard let prefs = try? await SettingsAPI.uiPrefs(user: requestContext.user) else { return }
        guard pendingLocalWrites == 0,
              requestGeneration == generation,
              context() == requestContext
        else { return }

        apply(
            prefs,
            identity: identity(for: requestContext),
            bucket: bucket(for: requestContext)
        )
    }

    /// Suspend periodic hydration while an optimistic cross-device preference
    /// write is queued or in flight. Otherwise a fresh hydrate can read the old
    /// server value before the PUT lands and repaint the local choice backward.
    static func beginLocalWrite() {
        generation += 1
        pendingLocalWrites += 1
    }

    static func endLocalWrite() {
        pendingLocalWrites = max(0, pendingLocalWrites - 1)
        generation += 1
    }

    @discardableResult
    static func apply(_ prefs: [String: String], for requestContext: Context) -> Bool {
        guard context() == requestContext else { return false }
        generation += 1
        apply(
            prefs,
            identity: identity(for: requestContext),
            bucket: bucket(for: requestContext)
        )
        return true
    }

    private static func apply(
        _ response: [String: String],
        identity: String,
        bucket: String
    ) {
        let defaults = UserDefaults.standard
        var prefs = response
        // Other settings endpoints return the whole preference map. While a
        // Support location PUT is pending, that map can still contain the old
        // pair; preserve the optimistic local pair while applying everything
        // else from the response.
        if pendingLocalWrites > 0 {
            prefs[SidebarTools.prefKey] = defaults.string(forKey: SidebarTools.storageKey)
                ?? SidebarTools.defaultHiddenJSON
            prefs[SidebarFeeds.prefKey] = defaults.string(forKey: SidebarFeeds.storageKey)
                ?? "[]"
            prefs[recentModelsPrefKey] = defaults.string(forKey: recentModelsStorageKey)
                ?? "[]"
        }
        let previousIdentity = defaults.string(forKey: identityKey)
        let previousBucket = defaults.string(forKey: bucketKey)
        let changedIdentity = previousIdentity != identity || previousBucket != bucket

        set(
            prefs["default-model"],
            default: "",
            key: "os1.composer.defaultModel",
            resetMissing: changedIdentity,
            in: defaults
        )
        // Keep ids this instance does not currently expose. They may become
        // available again on another workspace or device.
        set(
            validatedRecentModels(prefs[recentModelsPrefKey]),
            default: "[]",
            key: recentModelsStorageKey,
            resetMissing: changedIdentity,
            in: defaults
        )
        // Not validated against the engine list here: which engines exist is a
        // property of the instance, read where the preference is applied
        // (ModelCatalog.preferredID), so one that is turned off reads as no
        // preference rather than being forgotten.
        set(
            prefs["default-engine"],
            default: "",
            key: "os1.composer.defaultEngine",
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
        let legacyTurnActivity = prefs["turn-activity"].flatMap { TurnActivity.legacy[$0] }
        set(
            TurnActivity.Work(rawValue: prefs["turn-activity"] ?? "")?.rawValue
                ?? legacyTurnActivity?.work.rawValue,
            default: "running",
            key: "os1.appearance.turnActivity",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            TurnActivity.Tools(rawValue: prefs["tool-calls"] ?? "")?.rawValue
                ?? legacyTurnActivity?.tools.rawValue,
            default: "folded",
            key: "os1.appearance.toolCalls",
            resetMissing: changedIdentity,
            in: defaults
        )
        setBool(
            replySuggestionsEnabled(prefs["reply-suggestions"]),
            default: true,
            key: "os1.composer.replySuggestions",
            resetMissing: changedIdentity,
            in: defaults
        )
        setBool(
            nextChatButtonEnabled(prefs["next-chat-button"]),
            default: true,
            key: "os1.composer.nextChatButton",
            resetMissing: changedIdentity,
            in: defaults
        )
        setBool(
            liveTypingEnabled(prefs["live-typing"]),
            default: false,
            key: "os1.transcript.liveTyping",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            validatedIdList(prefs["repo-order"]),
            default: "[]",
            key: "os1.sidebar.repoOrder",
            resetMissing: true,
            in: defaults
        )
        // Sidebar sources the person hid, here or in the browser. Reset when
        // the pref is missing, like repo order: both are the account's, so an
        // absent value means "nothing hidden", not "keep what this device has".
        set(
            validatedIdList(prefs[SidebarFeeds.prefKey]),
            default: "[]",
            key: SidebarFeeds.storageKey,
            resetMissing: true,
            in: defaults
        )
        // Tools the person hid, here or in the browser. Same list shape as the
        // sources above, but a missing value means the shared defaults rather
        // than "nothing hidden": a tool nobody has switched on has never been
        // in the web sidebar either, and the phone showing it anyway is what
        // this pref exists to stop.
        set(
            validatedIdList(prefs[SidebarTools.prefKey]),
            default: SidebarTools.defaultHiddenJSON,
            key: SidebarTools.storageKey,
            resetMissing: true,
            in: defaults
        )
        set(
            validated(prefs["desk-voice"], allowed: ["on", "off"]),
            default: "off",
            key: "os1.desk.voice",
            resetMissing: changedIdentity,
            in: defaults
        )
        set(
            AccountShortcuts.validatedRawValue(prefs["shortcuts"]),
            default: AccountShortcuts.emptyRawValue,
            key: AccountShortcuts.storageKey,
            resetMissing: true,
            in: defaults
        )
        defaults.set(identity, forKey: identityKey)
        defaults.set(bucket, forKey: bucketKey)
    }

    private static func identity(for context: Context) -> String {
        let person = context.login.isEmpty ? "user:\(context.user)" : "github:\(context.login)"
        return "\(context.server)|\(person.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    private static func bucket(for context: Context) -> String {
        "\(context.server)|\(context.user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    private static func validated(_ value: String?, allowed: Set<String>) -> String? {
        guard let value, allowed.contains(value) else { return nil }
        return value
    }

    /// The web stores this boolean as "on"/"off" in ui-prefs. Unknown values
    /// are ignored so a newer client cannot accidentally disable the feature.
    static func replySuggestionsEnabled(_ value: String?) -> Bool? {
        switch value {
        case "on": true
        case "off": false
        default: nil
        }
    }

    /// Whether the Next chat button appears above the composer. The keyboard
    /// shortcut remains available when the button is hidden.
    static func nextChatButtonEnabled(_ value: String?) -> Bool? {
        switch value {
        case "on": true
        case "off": false
        default: nil
        }
    }

    /// Whether a reply types out as the model writes it. Same "on"/"off"
    /// shape as the web writes, and the same key, so the answer is one
    /// account's rather than one client's. Absent means off, which is the
    /// default on both.
    static func liveTypingEnabled(_ value: String?) -> Bool? {
        switch value {
        case "on": true
        case "off": false
        default: nil
        }
    }

    /// The cached answer this device holds, for the transcript to read per
    /// frame rather than capture: flipping the toggle then takes on a turn
    /// that is already running. Off until the account says otherwise.
    nonisolated static var liveTypingIsOn: Bool {
        UserDefaults.standard.object(forKey: "os1.transcript.liveTyping") as? Bool ?? false
    }

    /// Decode the web's newest-first recent-model list. Unknown model ids are
    /// deliberately retained; only malformed, blank and duplicate entries are
    /// removed, and storage is capped independently of the three visible rows.
    static func decodeRecentModels(_ value: String?) -> [String]? {
        guard let value,
              let data = value.data(using: .utf8),
              let values = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
        else { return nil }
        var seen = Set<String>()
        return values.compactMap { value -> String? in
            guard let id = value as? String,
                  !id.isEmpty,
                  seen.insert(id).inserted
            else { return nil }
            return id
        }.prefix(recentModelLimit).map { $0 }
    }

    static func addingRecentModel(_ id: String, to models: [String]) -> [String] {
        guard !id.isEmpty else { return Array(models.prefix(recentModelLimit)) }
        return Array(([id] + models.filter { $0 != id }).prefix(recentModelLimit))
    }

    static func availableRecentModelIDs(
        _ models: [String],
        available: Set<String>
    ) -> [String] {
        Array(models.filter(available.contains).prefix(recentModelDisplayLimit))
    }

    static func recordRecentModel(_ id: String) {
        guard !id.isEmpty else { return }
        let defaults = UserDefaults.standard
        let current = decodeRecentModels(defaults.string(forKey: recentModelsStorageKey)) ?? []
        let next = addingRecentModel(id, to: current)
        guard let data = try? JSONEncoder().encode(next) else { return }
        let raw = String(decoding: data, as: UTF8.self)
        defaults.set(raw, forKey: recentModelsStorageKey)

        let requestContext = context()
        let previousWrite = recentModelsWriteTail
        beginLocalWrite()
        recentModelsWriteTail = Task {
            defer { endLocalWrite() }
            // Each PUT replaces the whole recent list. Waiting for the prior
            // selection prevents an older snapshot from landing last.
            _ = await previousWrite?.value
            guard context() == requestContext,
                  let response = try? await SettingsAPI.updateUiPrefs(
                      user: requestContext.user,
                      prefs: [recentModelsPrefKey: raw]
                  )
            else { return }
            var confirmed = response
            if confirmed[recentModelsPrefKey] == nil { confirmed[recentModelsPrefKey] = raw }
            _ = apply(confirmed, for: requestContext)
        }
    }

    private static func validatedRecentModels(_ value: String?) -> String? {
        guard let models = decodeRecentModels(value),
              let data = try? JSONEncoder().encode(models)
        else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// The shape both list-valued prefs share (repo order, hidden sources): a
    /// JSON array of ids, trimmed, blanks and duplicates dropped, order kept.
    private static func validatedIdList(_ value: String?) -> String? {
        guard let value,
              let data = value.data(using: .utf8),
              let ids = try? JSONDecoder().decode([String].self, from: data)
        else { return nil }
        var seen = Set<String>()
        let normalized = ids.compactMap { id -> String? in
            let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return id
        }
        guard let encoded = try? JSONEncoder().encode(normalized) else { return nil }
        return String(decoding: encoded, as: UTF8.self)
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

    private static func setBool(
        _ value: Bool?,
        default defaultValue: Bool,
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
