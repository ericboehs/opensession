import Foundation
import Observation

/// Per-user pinned rows — the sidebar's quick-access band.
///
/// A pin is an overlay on a sidebar ROW key that only ever affects one user,
/// and it is quick access rather than a status: a pinned row is lifted into the
/// Pinned band at the top of the list AND stays in its normal band below, which
/// is the rule the web sidebar follows (src/frontend/components/Sidebar.tsx).
/// Same store the web writes (`GET/PUT /api/pins`, see src/server/pins.ts), so
/// a row pinned on the phone is pinned in the browser too.
///
/// Order matters: the array IS the band's display order (the web offers
/// drag-to-reorder), and a fresh pin goes to the FRONT rather than sinking
/// under older ones. The server drops pins when their work is archived
/// (`unpinEverywhere`), so a pin can never resurface archived rows.
@Observable
@MainActor
final class PinStore {
    static let shared = PinStore()

    /// Pin keys in the user's own order.
    private(set) var pins: [String] = []

    /// Key → slot in `pins`, so ranking a row during a body evaluation costs a
    /// dictionary lookup per session rather than a scan of the whole list.
    private var slots: [String: Int] = [:]

    private enum Change {
        case pin(String)
        case unpin(Set<String>)
    }

    /// Operations made before hydration. Replaying them over the fetched list
    /// preserves both local intent and pins created in another client.
    private var pendingChanges: [Change] = []
    private var mutationRevision = 0
    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false

    init() {}

    /// Load this user's list from the server, guarded like `HideStore.hydrate`:
    /// a stale response (server/user switched, or a pin landed meanwhile) is
    /// dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        guard let loaded = try? await SettingsAPI.pins(user: requestContext.user) else { return }
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
        apply([])
        pendingChanges.removeAll()
        hasHydrated = false
        mutationRevision += 1
    }

    /// Kept internal so the pre-hydration replay semantics are unit-testable.
    func applyHydrated(_ loaded: [String], persist: Bool = true) {
        var merged = loaded
        for change in pendingChanges {
            switch change {
            case .pin(let key):
                merged = [key] + merged.filter { $0 != key }
            case .unpin(let keys):
                merged.removeAll { keys.contains($0) }
            }
        }
        hasHydrated = true
        if merged != pins { apply(merged) }
        if persist, !pendingChanges.isEmpty { save() }
    }

    func isPinned(_ workspace: SidebarWorkspace) -> Bool {
        rank(workspace) != nil
    }

    /// This row's slot in the Pinned band, or nil when it isn't pinned. A row
    /// can be pinned under its own key or under one of its sessions' ids (the web
    /// pins workspaces by row key, but a pin made from a session predates that and
    /// still counts) — the earliest matching slot wins.
    func rank(_ workspace: SidebarWorkspace) -> Int? {
        matchingKeys(of: workspace).compactMap { slots[$0] }.min()
    }

    func toggle(_ workspace: SidebarWorkspace) {
        if isPinned(workspace) {
            unpin(workspace)
        } else {
            let key = SidebarRowKeys.rowKey(for: workspace)
            guard SidebarRowKeys.isPersistable(key) else { return }
            apply([key] + pins.filter { $0 != key })
            record(.pin(key))
            save()
        }
    }

    /// Drop every key this row is pinned under. Also called when the row is
    /// archived: the server unpins archived work for everyone, and leaving the
    /// key in the local list would keep a dead row in the band until the next
    /// hydrate.
    func unpin(_ workspace: SidebarWorkspace) {
        let doomed = Set(matchingKeys(of: workspace))
        guard !doomed.isEmpty else { return }
        apply(pins.filter { !doomed.contains($0) })
        record(.unpin(doomed))
        save()
    }

    /// The keys this row is currently pinned under, deduped.
    private func matchingKeys(of workspace: SidebarWorkspace) -> [String] {
        guard !slots.isEmpty else { return [] }
        var seen = Set<String>()
        return ([SidebarRowKeys.rowKey(for: workspace)] + workspace.sessions.map(\.id))
            .filter { slots[$0] != nil && seen.insert($0).inserted }
    }

    private func apply(_ next: [String]) {
        pins = next
        slots = Dictionary(next.enumerated().map { ($0.element, $0.offset) }) { first, _ in first }
    }

    private func record(_ change: Change) {
        pendingChanges.append(change)
        mutationRevision += 1
    }

    private func save() {
        guard hasHydrated else { return }
        let user = ServerConfig.shared.userName
        let snapshot = pins
        let revision = mutationRevision
        // Fire-and-forget, like the web and like HideStore: the list is local
        // truth and a failed PUT costs nothing worth an error banner.
        Task { [weak self] in
            guard (try? await SettingsAPI.savePins(user: user, pins: snapshot)) != nil,
                  let self,
                  self.mutationRevision == revision
            else { return }
            self.pendingChanges.removeAll()
        }
    }
}
