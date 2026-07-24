import Foundation
import Observation

/// Sessions overview. The server has no push channel for list changes, so this
/// polls `GET /api/sessions` (server caches for 2s; the web UI polls at 5s too).
@Observable
@MainActor
final class SessionsListViewModel {
    private(set) var sessions: [Session] = []
    private(set) var error: String?
    private(set) var hasLoaded = false

    private var pollTask: Task<Void, Never>?

    /// Just-created sessions rendered before the server's list includes them.
    /// Dropped once the real row appears (or after a 2-minute safety window).
    private var optimistic: [String: (session: Session, added: Date)] = [:]

    /// Show a locally-built row for a just-created session immediately.
    func addOptimistic(_ session: Session) {
        optimistic[session.id] = (session, Date())
        sessions = mergeOptimistic(into: sessions)
    }

    /// The background create resolved: move a pending row onto the server's
    /// real id (still in the optimistic overlay until polling returns the
    /// server's own row for it).
    func resolveOptimistic(tempId: String, realId: String) {
        guard let entry = optimistic.removeValue(forKey: tempId) else { return }
        let old = entry.session
        let real = Session.optimistic(
            id: realId,
            title: old.title ?? "",
            repo: old.repo ?? "",
            mode: old.mode ?? "code",
            model: old.model,
            effort: old.effort,
            fastMode: old.fastMode ?? false,
            startedBy: old.startedBy ?? ""
        )
        optimistic[realId] = (real, entry.added)
        sessions = sessions.map { $0.id == tempId ? real : $0 }
    }

    /// Roll back a pending row whose create failed.
    func removeOptimistic(_ id: String) {
        optimistic.removeValue(forKey: id)
        sessions.removeAll { $0.id == id }
    }

    /// Sessions archived locally that the server's (2s-cached) list may still
    /// include for a poll or two — suppressed until it catches up, with a
    /// safety expiry so a failed archive doesn't hide the row forever.
    private var locallyArchived: [String: Date] = [:]

    /// Swipe-to-archive: drop the row immediately, tell the server in the
    /// background, and roll back (surfacing the error) if that fails.
    func archive(_ session: Session) {
        sessions.removeAll { $0.id == session.id }
        locallyArchived[session.id] = Date()
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: true)
            } catch {
                locallyArchived.removeValue(forKey: session.id)
                self.error = "Couldn't archive: \(error.localizedDescription)"
                await refresh()
            }
        }
    }

    private func isLocallyArchived(_ id: String) -> Bool {
        guard let added = locallyArchived[id] else { return false }
        if Date().timeIntervalSince(added) > 30 {
            locallyArchived.removeValue(forKey: id)
            return false
        }
        return true
    }

    private func mergeOptimistic(into list: [Session]) -> [Session] {
        guard !optimistic.isEmpty else { return list }
        let serverIds = Set(list.map(\.id))
        var extras: [Session] = []
        for (id, entry) in optimistic {
            if serverIds.contains(id) || Date().timeIntervalSince(entry.added) > 120 {
                optimistic.removeValue(forKey: id)
            } else {
                extras.append(entry.session)
            }
        }
        return extras.isEmpty ? list : extras + list
    }

    func startPolling() {
        stopPolling()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        do {
            let all = try await OS1API.sessions()
            let next = mergeOptimistic(into: all
                .filter { $0.archived != true && $0.desk != true && !isLocallyArchived($0.id) }
                .sorted {
                    ($0.lastActivityDate ?? .distantPast) > ($1.lastActivityDate ?? .distantPast)
                })
            // Most 5s polls change nothing — skip the assignment so the whole
            // list doesn't re-diff (grouping, sorting, row rebuilds) for a
            // byte-identical result.
            if next != sessions { sessions = next }
            error = nil
        } catch {
            // Keep showing the last good list; surface the error alongside it.
            self.error = error.localizedDescription
        }
        hasLoaded = true
    }
}
