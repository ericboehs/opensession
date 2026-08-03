import Foundation
import Observation

/// Sessions overview. The server has no push channel for list changes, so this
/// polls `GET /api/sessions` (server caches for 2s; the web UI polls at 5s too).
@Observable
@MainActor
final class SessionsListViewModel {
    private(set) var sessions: [Session] = []
    private(set) var archivedSessions: [Session] = []
    private(set) var workspaceNames: [String: String] = [:]
    private(set) var error: String?
    private(set) var hasLoaded = false

    private var pollTask: Task<Void, Never>?

    /// Honor the web sidebar's shared order, then append newly seen repositories
    /// by frequency with a stable alphabetical tie-breaker.
    nonisolated static func repositoryOrder(
        in sessions: [Session],
        preferredOrderJSON: String = "[]"
    ) -> [String] {
        var counts: [String: Int] = [:]
        for session in sessions where session.archived != true {
            counts[session.effectiveRepo, default: 0] += 1
        }
        let discovered = counts.keys.sorted {
            let left = counts[$0, default: 0]
            let right = counts[$1, default: 0]
            return left != right ? left > right : $0.localizedStandardCompare($1) == .orderedAscending
        }
        let preferred = (try? JSONDecoder().decode(
            [String].self,
            from: Data(preferredOrderJSON.utf8)
        )) ?? []
        var seen = Set<String>()
        let ordered = preferred.filter { counts[$0] != nil && seen.insert($0).inserted }
        return ordered + discovered.filter { seen.insert($0).inserted }
    }

    /// Live sibling chats shown in the conversation tab strip. This mirrors
    /// the web client: workspace membership wins, with isolated worktrees as
    /// the fallback for legacy rows, and the natural order is oldest first.
    nonisolated static func tabSessions(
        in sessions: [Session], containing current: Session
    ) -> [Session] {
        // NavigationPath retains the row snapshot that was originally pushed.
        // Prefer the latest polled copy so a newly filed optimistic session
        // joins its workspace without requiring the conversation to reopen.
        let current = sessions.first { $0.id == current.id } ?? current
        let belongs: (Session) -> Bool
        if let projectId = current.projectId, !projectId.isEmpty {
            let dir = isolatedWorktree(for: current)
            belongs = {
                $0.projectId == projectId
                    || (dir != nil && $0.projectId?.isEmpty != false
                        && isolatedWorktree(for: $0) == dir)
            }
        } else if let dir = isolatedWorktree(for: current) {
            belongs = { isolatedWorktree(for: $0) == dir }
        } else {
            return [current]
        }
        var tabs = sessions.filter {
            belongs($0)
                && $0.sideChatOf == nil
                && ($0.archived != true || $0.id == current.id)
        }
        if !tabs.contains(where: { $0.id == current.id }) {
            tabs.append(current)
        }
        tabs.sort {
            let left = $0.createdAt ?? ""
            let right = $1.createdAt ?? ""
            return left == right ? $0.id < $1.id : left < right
        }
        let main = mainSession(in: tabs)
        guard let main else { return [] }
        return [main] + tabs.filter { $0.id != main.id }
    }

    /// One sidebar row per workspace, with isolated worktrees as the fallback
    /// for legacy projectless rows. A projectless row adopts the one workspace
    /// already using its worktree, but separate workspaces are never merged
    /// merely because their paths happen to match.
    nonisolated static func sidebarWorkspaces(
        in sessions: [Session],
        workspaceNames: [String: String] = [:]
    ) -> [SidebarWorkspace] {
        let visible = sessions.filter { $0.sideChatOf == nil }
        let projectKeyByWorktree = Dictionary(grouping: visible.filter {
            $0.projectId?.isEmpty == false && isolatedWorktree(for: $0) != nil
        }, by: { isolatedWorktree(for: $0)! }).compactMapValues { chats in
            let keys = Set(chats.compactMap(\.projectId))
            return keys.count == 1 ? "workspace:\(keys.first!)" : nil
        }
        var order: [String] = []
        var grouped: [String: [Session]] = [:]
        for session in visible {
            let key: String
            if session.projectId?.isEmpty != false,
               let dir = isolatedWorktree(for: session),
               let projectKey = projectKeyByWorktree[dir] {
                key = projectKey
            } else {
                key = workspaceKey(for: session)
            }
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(session)
        }
        return order.compactMap { key in
            guard var chats = grouped[key] else { return nil }
            chats.sort(by: sessionNaturalOrder)
            guard let main = mainSession(in: chats) else { return nil }
            let named = chats.compactMap(\.projectId).compactMap { workspaceNames[$0] }.first
            let renamed = chats.first { $0.titleOverridden == true }
            let worktreeName = main.worktreeDir.flatMap {
                $0.contains("/worktrees/")
                    ? URL(fileURLWithPath: $0).lastPathComponent
                    : nil
            }
            return SidebarWorkspace(
                id: key,
                title: named ?? renamed?.displayTitle ?? main.branch ?? worktreeName ?? main.displayTitle,
                sessions: chats,
                mainSession: main
            )
        }
    }

    nonisolated private static func workspaceKey(for session: Session) -> String {
        if let projectId = session.projectId, !projectId.isEmpty {
            return "workspace:\(projectId)"
        }
        if let dir = isolatedWorktree(for: session) { return "worktree:\(dir)" }
        return "session:\(session.id)"
    }

    nonisolated private static func isolatedWorktree(for session: Session) -> String? {
        guard let dir = session.worktreeDir,
              dir.contains("/worktrees/") else { return nil }
        return dir
    }

    nonisolated private static func sessionNaturalOrder(_ left: Session, _ right: Session) -> Bool {
        let leftDate = left.createdAt ?? ""
        let rightDate = right.createdAt ?? ""
        return leftDate == rightDate ? left.id < right.id : leftDate < rightDate
    }

    nonisolated private static func mainSession(in sessions: [Session]) -> Session? {
        sessions.first { !$0.isAutomation && !$0.neverRan }
            ?? sessions.first { !$0.neverRan }
            ?? sessions.first
    }

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
            repo: old.effectiveRepo,
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
    private var locallyArchived: [String: (session: Session, added: Date)] = [:]

    /// Swipe-to-archive: drop the row immediately, tell the server in the
    /// background, and roll back (surfacing the error) if that fails.
    func archive(_ session: Session) {
        sessions.removeAll { $0.id == session.id }
        var archived = session
        archived.archived = true
        locallyArchived[session.id] = (archived, Date())
        archivedSessions.removeAll { $0.id == session.id }
        archivedSessions.insert(archived, at: 0)
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: true)
            } catch {
                locallyArchived.removeValue(forKey: session.id)
                archivedSessions.removeAll { $0.id == session.id }
                self.error = "Couldn't archive: \(error.localizedDescription)"
                await refresh()
            }
        }
    }

    /// Restore from the archived list immediately, then reconcile with the
    /// server. The short-lived suppression avoids a cached archived row
    /// flashing back into the sheet before the PATCH reaches `/api/sessions`.
    func unarchive(_ session: Session) {
        archivedSessions.removeAll { $0.id == session.id }
        locallyUnarchived[session.id] = Date()
        var restored = session
        restored.archived = false
        sessions.insert(restored, at: 0)
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: false)
            } catch {
                locallyUnarchived.removeValue(forKey: session.id)
                sessions.removeAll { $0.id == session.id }
                self.error = "Couldn't restore: \(error.localizedDescription)"
                await refresh()
            }
        }
    }

    func rename(_ workspace: SidebarWorkspace, to proposedName: String) {
        let name = proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
        if workspace.projectId != nil, name.isEmpty { return }

        Task {
            do {
                if let projectId = workspace.projectId {
                    try await OS1API.renameWorkspace(workspaceId: projectId, name: name)
                } else if name.isEmpty {
                    for session in workspace.sessions where session.titleOverridden == true {
                        try await OS1API.renameSession(sessionId: session.id, title: "")
                    }
                } else {
                    let session = workspace.sessions.first { $0.titleOverridden == true }
                        ?? workspace.mainSession
                    try await OS1API.renameSession(
                        sessionId: session.id,
                        title: name
                    )
                }
                await refresh()
            } catch {
                self.error = workspace.projectId == nil
                    ? "Couldn't rename chat: \(error.localizedDescription)"
                    : "Couldn't rename workspace: \(error.localizedDescription)"
            }
        }
    }

    private func isLocallyArchived(_ id: String) -> Bool {
        guard let entry = locallyArchived[id] else { return false }
        if Date().timeIntervalSince(entry.added) > 30 {
            locallyArchived.removeValue(forKey: id)
            return false
        }
        return true
    }

    private var locallyUnarchived: [String: Date] = [:]

    private func isLocallyUnarchived(_ id: String) -> Bool {
        guard let added = locallyUnarchived[id] else { return false }
        if Date().timeIntervalSince(added) > 30 {
            locallyUnarchived.removeValue(forKey: id)
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
            async let workspaceRequest = try? OS1API.workspaces()
            let all = try await OS1API.sessions()
            if let workspaces = await workspaceRequest {
                let nextNames = Dictionary(uniqueKeysWithValues: workspaces.map { ($0.id, $0.name) })
                if nextNames != workspaceNames { workspaceNames = nextNames }
            }
            // Snapshot the main-actor state the filter needs, then do the
            // heavy pass (thousands of rows) off the main thread — inline it
            // ran on the main actor every 5s poll and hitched typing.
            let hiddenIds = Set(Array(locallyArchived.keys).filter { isLocallyArchived($0) })
            let restoredIds = Set(Array(locallyUnarchived.keys).filter { isLocallyUnarchived($0) })
            let localArchivedRows = hiddenIds.compactMap { locallyArchived[$0]?.session }
            let prepared = await Task.detached(priority: .userInitiated) {
                Self.prepared(all, hiding: hiddenIds, restoring: restoredIds)
            }.value
            let next = mergeOptimistic(into: prepared.active)
            let serverArchivedIds = Set(prepared.archived.map(\.id))
            for id in serverArchivedIds {
                locallyArchived.removeValue(forKey: id)
            }
            let archivedNext = localArchivedRows.filter { !serverArchivedIds.contains($0.id) }
                + prepared.archived
            // Most 5s polls change nothing — skip the assignment so the whole
            // list doesn't re-diff (grouping, sorting, row rebuilds) for a
            // byte-identical result.
            if next != sessions { sessions = next }
            if archivedNext != archivedSessions {
                archivedSessions = archivedNext
            }
            error = nil
        } catch {
            // Keep showing the last good list; surface the error alongside it.
            self.error = error.localizedDescription
        }
        hasLoaded = true
    }

    /// Drop archived/desk/locally-hidden rows and sort by last activity.
    /// Decorated sort on purpose: the comparator form re-parsed each row's
    /// ISO date ~2·log n times, which multiplied into hundreds of
    /// milliseconds per poll at this list size — parse once per row instead.
    nonisolated private static func prepared(
        _ all: [Session],
        hiding hiddenIds: Set<String>,
        restoring restoredIds: Set<String>
    ) -> (active: [Session], archived: [Session]) {
        let visible = all.filter { $0.desk != true }
        let active = visible
            .filter {
                ($0.archived != true || restoredIds.contains($0.id))
                    && !hiddenIds.contains($0.id)
            }
            .map { session -> Session in
                guard restoredIds.contains(session.id) else { return session }
                var restored = session
                restored.archived = false
                return restored
            }
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
        let archived = visible
            .filter { $0.archived == true && !restoredIds.contains($0.id) }
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
        return (active, archived)
    }
}

struct SidebarWorkspace: Identifiable, Equatable {
    let id: String
    let title: String
    let sessions: [Session]
    let mainSession: Session

    var statusSession: Session {
        let humanSessions = sessions.filter { !$0.isAutomation }
        let candidates = humanSessions.isEmpty ? sessions : humanSessions
        return candidates.min { statusRank($0) < statusRank($1) } ?? mainSession
    }

    var lane: Session.Lane { statusSession.lane }
    var projectId: String? {
        sessions.compactMap(\.projectId).first { !$0.isEmpty }
    }
    var isOptimistic: Bool {
        sessions.contains {
            $0.id.hasPrefix("pending-") || $0.isOptimisticPlaceholder == true
        }
    }
    var effectiveRepo: String { mainSession.effectiveRepo }
    var lastActivityDate: Date {
        sessions.compactMap(\.lastActivityDate).max() ?? .distantPast
    }
    var createdDate: Date {
        sessions.compactMap { Session.parseISO($0.createdAt) }.min() ?? .distantPast
    }

    private func statusRank(_ session: Session) -> Int {
        switch session.lane {
        case .needsInput: 0
        case .inProgress: 1
        case .inReview: 2
        case .done: 3
        case .backlog: 4
        }
    }
}
