import Foundation
import Observation

/// Per-user sidebar hides — the personal counterpart to archiving.
///
/// Archiving is global (it removes a session for the whole team), which is the
/// wrong tool for "this isn't mine to watch anymore" while a teammate is still
/// working in the session. A hide is an overlay on a sidebar ROW key that only
/// ever affects one user; the session keeps running and stays in everyone else's
/// sidebar. Same store the web sidebar writes (`GET/PUT /api/hides`, see
/// src/server/hides.ts and src/frontend/lib/hides.ts), so a row hidden on the
/// phone is hidden in the browser too.
///
/// There is deliberately no "Hidden" band: hiding means the row is off your
/// sidebar, not filed into a drawer. Search ignores hides — that's how a
/// hidden row is found again, and its context menu then offers to restore it.
/// Two rules keep a hide from swallowing work: a hidden row resurfaces (and
/// its entry is consumed) while one of its sessions is blocked on a question, and
/// prompting in a session clears its hide outright.
@Observable
@MainActor
final class HideStore {
    static let shared = HideStore()

    /// Sidebar row key → ISO timestamp of when this user hid it.
    private(set) var hides: [String: String] = [:]

    private enum Change {
        case set(String)
        case remove
    }

    /// Local intent survives the first remote response. Without tombstones, a
    /// pre-hydration restore could be undone by an older server hide.
    private var pendingChanges: [String: Change] = [:]
    private var mutationRevision = 0
    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false

    init() {}

    /// Load this user's map from the server. Guarded like
    /// `NativePreferences.hydrate`: a stale response (server/user switched, or
    /// a hide landed meanwhile) is dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        guard let loaded = try? await SettingsAPI.hides(user: requestContext.user) else { return }
        guard NativePreferences.context() == requestContext else { return }
        applyHydrated(loaded)
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        hides = [:]
        pendingChanges.removeAll()
        hasHydrated = false
        mutationRevision += 1
    }

    /// Kept internal so the local-before-remote merge can be covered in tests.
    func applyHydrated(_ loaded: [String: String], persist: Bool = true) {
        var merged = loaded
        for (key, change) in pendingChanges {
            switch change {
            case .set(let timestamp): merged[key] = timestamp
            case .remove: merged.removeValue(forKey: key)
            }
        }
        hasHydrated = true
        if merged != hides { hides = merged }
        if persist, !pendingChanges.isEmpty { save() }
    }

    func isHidden(_ workspace: SidebarWorkspace) -> Bool {
        hides[SidebarRowKeys.rowKey(for: workspace)] != nil
    }

    func hide(_ workspace: SidebarWorkspace) {
        let key = SidebarRowKeys.rowKey(for: workspace)
        guard SidebarRowKeys.isPersistable(key), hides[key] == nil else { return }
        let timestamp = Self.timestamp.string(from: .now)
        hides[key] = timestamp
        record(.set(timestamp), for: key)
        save()
    }

    /// Drop hide entries. Takes a list so a poll can consume several resurfaced
    /// rows in one write; idempotent.
    func clear(_ keys: [String]) {
        let doomed = keys.filter { hides[$0] != nil }
        guard !doomed.isEmpty else { return }
        for key in doomed {
            hides.removeValue(forKey: key)
            record(.remove, for: key)
        }
        save()
    }

    /// Clear the hide covering a session, whichever row key its row uses. Called
    /// when the user PROMPTS in a session: you can't be done with a session you're
    /// actively working in, and "I replied but it's still gone" reads as a bug.
    /// Opening a hidden session deliberately does NOT unhide it.
    func unhide(for session: Session) {
        clear(SidebarRowKeys.candidateKeys(for: session))
    }

    private func record(_ change: Change, for key: String) {
        pendingChanges[key] = change
        mutationRevision += 1
    }

    private func save() {
        guard hasHydrated else { return }
        let user = ServerConfig.shared.userName
        let snapshot = hides
        let revision = mutationRevision
        // Fire-and-forget, like the web: the map is local truth and a failed
        // PUT costs nothing worth an error banner.
        Task { [weak self] in
            guard (try? await SettingsAPI.saveHides(user: user, hides: snapshot)) != nil,
                  let self,
                  self.mutationRevision == revision
            else { return }
            self.pendingChanges.removeAll()
        }
    }

    private static let timestamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

}
