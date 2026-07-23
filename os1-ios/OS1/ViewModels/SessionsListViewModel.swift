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
            let next = all
                .filter { $0.archived != true }
                .sorted {
                    ($0.lastActivityDate ?? .distantPast) > ($1.lastActivityDate ?? .distantPast)
                }
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
