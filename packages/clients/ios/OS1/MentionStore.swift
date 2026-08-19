import Foundation
import Observation

/// One outstanding teammate mention, shared with the web sidebar through
/// `GET /api/mentions`. The server keeps one record per person and session.
struct MentionRecord: Codable, Equatable, Sendable {
    let sessionId: String
    let by: String
    let source: String?
    let preview: String?
    let ts: Double?
}

/// Sessions where a teammate tagged this person.
///
/// This is server-owned state rather than a device preference: a mention must
/// appear on every signed-in device, and opening it on any one clears the badge
/// everywhere. The app-wide socket feeds live changes while REST hydration
/// restores anything that arrived while the app was closed.
@Observable
@MainActor
final class MentionStore {
    static let shared = MentionStore()

    private(set) var mentions: [String: MentionRecord] = [:]
    private(set) var hasHydrated = false
    private(set) var openSessionId: String?

    private var hydratedContext: NativePreferences.Context?
    private var mutationRevision = 0

    init() {}

    var sessionIds: Set<String> { Set(mentions.keys) }

    func mention(for sessions: [Session]) -> MentionRecord? {
        sessions.compactMap { mentions[$0.id] }.max {
            ($0.ts ?? 0) < ($1.ts ?? 0)
        }
    }

    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let requestRevision = mutationRevision
        guard let loaded = try? await SettingsAPI.mentions(user: requestContext.user) else {
            return
        }
        guard NativePreferences.context() == requestContext,
              mutationRevision == requestRevision
        else { return }
        applyHydrated(loaded)
    }

    /// Kept internal so REST hydration and open-session behavior can be tested
    /// without a server. The wire is one record per session; if an older server
    /// returns duplicates, the newest record wins.
    func applyHydrated(_ loaded: [MentionRecord], persist: Bool = true) {
        var next: [String: MentionRecord] = [:]
        for mention in loaded {
            if let current = next[mention.sessionId], (current.ts ?? 0) > (mention.ts ?? 0) {
                continue
            }
            next[mention.sessionId] = mention
        }
        hasHydrated = true
        if let openSessionId, next.removeValue(forKey: openSessionId) != nil, persist {
            clearOnServer(openSessionId)
        }
        if next != mentions { mentions = next }
    }

    /// Apply the server's live `mention` frame. A mention addressed to another
    /// teammate is irrelevant; one landing in the session already on screen is
    /// already seen and is cleared again immediately.
    func receive(user: String, mention: MentionRecord, persist: Bool = true) {
        guard isCurrentUser(user) else { return }
        mutationRevision += 1
        if mention.sessionId == openSessionId {
            if persist { clearOnServer(mention.sessionId) }
            return
        }
        if mentions[mention.sessionId] != mention {
            mentions[mention.sessionId] = mention
        }
    }

    /// Apply the server's live `mentions_cleared` frame. A missing session id
    /// means another device cleared the whole list.
    func receiveCleared(user: String, sessionId: String?) {
        guard isCurrentUser(user) else { return }
        mutationRevision += 1
        if let sessionId {
            mentions.removeValue(forKey: sessionId)
        } else {
            mentions.removeAll()
        }
    }

    /// Opening is the read action, matching the web viewer. Keeping the open id
    /// also handles a mention that arrives while the conversation is visible.
    func open(_ sessionId: String, persist: Bool = true) {
        openSessionId = sessionId
        guard mentions.removeValue(forKey: sessionId) != nil else { return }
        mutationRevision += 1
        if persist { clearOnServer(sessionId) }
    }

    func close(_ sessionId: String) {
        if openSessionId == sessionId { openSessionId = nil }
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        mentions = [:]
        openSessionId = nil
        hasHydrated = false
        mutationRevision += 1
    }

    private func isCurrentUser(_ user: String) -> Bool {
        user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            == NativePreferences.context().user
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func clearOnServer(_ sessionId: String) {
        let context = NativePreferences.context()
        let connection = SettingsAPI.Connection.current()
        Task {
            _ = try? await SettingsAPI.clearMention(
                user: context.user,
                sessionId: sessionId,
                connection: connection
            )
        }
    }
}
