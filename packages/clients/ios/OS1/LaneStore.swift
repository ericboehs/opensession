import Foundation
import Observation

/// Per-user sidebar lane claims. A claim pulls teammate, automation, or
/// spawned work into this person's own sidebar without changing workspace
/// state for anyone else.
@Observable
@MainActor
final class LaneStore {
    static let shared = LaneStore()

    typealias Reader = @MainActor (_ user: String) async throws -> [String: String]
    typealias Writer = @MainActor (
        _ user: String,
        _ set: [String: String],
        _ connection: SettingsAPI.Connection?
    ) async throws -> [String: String]

    /// Session ids this user has claimed, regardless of the lane value.
    private(set) var claims: Set<String> = []

    private var lanes: [String: String] = [:]
    /// Local intent survives hydration and in-flight writes. Each key is a
    /// delta, never a whole-map snapshot, so other clients' claims are safe.
    private var pendingChanges: [String: String] = [:]
    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false
    private var isSaving = false
    private var mutationRevision = 0
    @ObservationIgnored private let reader: Reader
    @ObservationIgnored private let writer: Writer

    init(
        reader: @escaping Reader = { user in try await SettingsAPI.lanes(user: user) },
        writer: @escaping Writer = { user, set, connection in
            try await SettingsAPI.saveLanes(
                user: user,
                set: set,
                connection: connection
            )
        }
    ) {
        self.reader = reader
        self.writer = writer
    }

    /// Load this user's map from the server. A response for a server/user that
    /// has since changed is dropped, while mutations made before it landed are
    /// replayed over it.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let requestRevision = mutationRevision
        guard let loaded = try? await reader(requestContext.user) else { return }
        guard NativePreferences.context() == requestContext,
              mutationRevision == requestRevision else { return }
        applyHydrated(loaded)
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        lanes = [:]
        claims = []
        pendingChanges.removeAll()
        hasHydrated = false
        isSaving = false
        mutationRevision += 1
    }

    /// Claim every session represented by a sidebar row. Optimistic locally;
    /// persistence waits for hydration so a startup mutation cannot overwrite
    /// remote state it has not seen yet.
    func claim(_ sessions: [Session]) {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let ids = Set(sessions.map(\.id)).subtracting(claims)
        guard !ids.isEmpty else { return }
        for id in ids {
            lanes[id] = "mine"
            pendingChanges[id] = "mine"
        }
        mutationRevision += 1
        claims.formUnion(ids)
        save()
    }

    /// Internal so pre-hydration mutation reconciliation is unit-testable.
    func applyHydrated(_ loaded: [String: String], persist: Bool = true) {
        var merged = loaded
        for (key, value) in pendingChanges { merged[key] = value }
        hasHydrated = true
        apply(merged)
        if persist, !pendingChanges.isEmpty { save() }
    }

    /// Reconcile one successful delta response without dropping a newer local
    /// mutation that landed while that request was in flight.
    func applySaved(_ saved: [String: String], acknowledging captured: [String: String]) {
        for (key, value) in captured where pendingChanges[key] == value {
            pendingChanges.removeValue(forKey: key)
        }
        mutationRevision += 1
        applyHydrated(saved, persist: false)
    }

    private func apply(_ next: [String: String]) {
        lanes = next
        let nextClaims = Set(next.keys)
        if nextClaims != claims { claims = nextClaims }
    }

    private func save() {
        guard hasHydrated,
              !isSaving,
              !pendingChanges.isEmpty,
              let requestContext = hydratedContext,
              NativePreferences.context() == requestContext else { return }
        let captured = pendingChanges
        let connection = SettingsAPI.Connection.current()
        isSaving = true
        Task { [weak self, writer] in
            let saved = try? await writer(
                requestContext.user,
                captured,
                connection
            )
            guard let self,
                  self.hydratedContext == requestContext,
                  NativePreferences.context() == requestContext else { return }
            self.isSaving = false
            guard let saved else { return }
            self.applySaved(saved, acknowledging: captured)
            self.save()
        }
    }
}
