import Foundation
import Observation

/// Per-user sidebar lane claims shared with the web sidebar.
///
/// A claim pulls a teammate's, automation's, or agent-started session into
/// your own list. Native groups rows by activity rather than the web's status
/// lanes, so only the claimed ids matter here; new native claims use `mine` and
/// continue following their natural activity state.
@Observable
@MainActor
final class LaneStore {
    static let shared = LaneStore()

    typealias Reader = @MainActor (_ user: String) async throws -> [String: String]
    typealias Writer = @MainActor (
        _ user: String,
        _ set: [String: String],
        _ remove: [String],
        _ connection: SettingsAPI.Connection?
    ) async throws -> [String: String]

    /// Session ids this user has claimed.
    private(set) var claims: Set<String> = []

    private var serverLanes: [String: String] = [:]
    private var pendingClaims: Set<String> = []
    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false
    private var isSaving = false
    private var mutationRevision = 0
    @ObservationIgnored private let reader: Reader
    @ObservationIgnored private let writer: Writer

    init(
        reader: @escaping Reader = { user in try await SettingsAPI.lanes(user: user) },
        writer: @escaping Writer = { user, set, remove, connection in
            try await SettingsAPI.saveLanes(
                user: user,
                set: set,
                remove: remove,
                connection: connection
            )
        }
    ) {
        self.reader = reader
        self.writer = writer
    }

    /// Load this user's map from the server. Local claims made before the GET
    /// landed are replayed over it rather than being painted backward.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let requestRevision = mutationRevision
        guard let loaded = try? await reader(requestContext.user) else { return }
        guard NativePreferences.context() == requestContext,
              mutationRevision == requestRevision else { return }
        applyHydrated(loaded)
    }

    /// Reset immediately when a view acts after an account switch. Hydration
    /// also calls this; keeping it internal makes stale-write behavior testable.
    func syncContext() {
        resetForNewContext(NativePreferences.context())
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        serverLanes = [:]
        pendingClaims = []
        claims = []
        hasHydrated = false
        isSaving = false
        mutationRevision += 1
    }

    /// Kept internal so hydration and optimistic-write behavior can be covered
    /// without a server.
    func applyHydrated(_ loaded: [String: String], persist: Bool = true) {
        serverLanes = loaded
        hasHydrated = true
        rebuildClaims()
        if persist { save() }
    }

    /// The web claims every session represented by the workspace row. Doing
    /// the same keeps the row claimed as the selected tab changes.
    func claim(_ sessions: [Session]) {
        syncContext()
        let ids = Set(sessions.lazy.map(\.id).filter { !$0.isEmpty })
        let additions = ids.subtracting(claims)
        guard !additions.isEmpty else { return }
        pendingClaims.formUnion(additions)
        mutationRevision += 1
        rebuildClaims()
        save()
    }

    /// Add is for an opened row that does not already belong to this person.
    /// A normal session they started makes the whole workspace naturally
    /// listed. Spawned and automation sessions deliberately do not, matching
    /// the web correction in ae1a1f9dd and `PeopleLens` ownership semantics.
    static func canAddToSidebar(
        session: Session,
        workspaceSessions: [Session],
        lens: PeopleLens,
        claims: Set<String>
    ) -> Bool {
        guard session.archived != true, !session.isOptimistic else { return false }
        let sessions = workspaceSessions.isEmpty ? [session] : workspaceSessions
        guard !sessions.contains(where: { claims.contains($0.id) }) else { return false }
        let naturalLens = PeopleLens(names: lens.names, claims: [])
        let naturallyListed = sessions.contains { candidate in
            candidate.spawnedBy?.isEmpty != false
                && !candidate.isAutomation
                && naturalLens.isMine(candidate)
        }
        return !naturallyListed
    }

    private func rebuildClaims() {
        let next = Set(serverLanes.keys).union(pendingClaims)
        if next != claims { claims = next }
    }

    private func save() {
        guard hasHydrated,
              !isSaving,
              !pendingClaims.isEmpty,
              let requestContext = hydratedContext,
              NativePreferences.context() == requestContext else { return }
        let captured = pendingClaims
        let set = Dictionary(uniqueKeysWithValues: captured.map { ($0, "mine") })
        let connection = SettingsAPI.Connection.current()
        isSaving = true
        Task { [weak self, writer] in
            let result: Result<[String: String], Error>
            do {
                result = .success(try await writer(requestContext.user, set, [], connection))
            } catch {
                result = .failure(error)
            }
            guard let self,
                  self.hydratedContext == requestContext,
                  NativePreferences.context() == requestContext else { return }
            self.isSaving = false
            switch result {
            case .success(let saved):
                self.pendingClaims.subtract(captured)
                self.serverLanes = saved
                self.mutationRevision += 1
                self.rebuildClaims()
                self.save()
            case .failure:
                // Keep optimistic intent. The next hydration retries it rather
                // than making a transient network failure remove the row.
                self.rebuildClaims()
            }
        }
    }
}
