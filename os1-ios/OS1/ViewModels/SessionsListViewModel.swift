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

    /// Memoized sidebar rows for the current list — see `sidebarRows`.
    ///
    /// Observation-ignored on purpose: `sidebarWorkspaces` fills it from its
    /// own getter, and an observed write during a view body evaluation would
    /// invalidate the view that is being evaluated.
    @ObservationIgnored private var sidebarRowsCache: [SidebarWorkspace]?

    /// Bumped by every mutation of the grouping's inputs, so a detached prime
    /// can tell whether the list moved under it without an O(n) comparison.
    @ObservationIgnored private var sessionsRevision = 0

    /// The sidebar's rows: workspace groups, memoized.
    ///
    /// The grouping walks every session — dictionary builds, worktree path
    /// parsing, a sort per row — and the list view reads it several times per
    /// body evaluation. A `sample` of a cold launch (5.5k rows) had the main
    /// thread inside this call for ~70% of the trace, which is why the app
    /// took minutes to become usable. `refresh` primes the cache off the main
    /// actor, so in the steady state a read here costs nothing.
    var sidebarWorkspaces: [SidebarWorkspace] {
        // Read the inputs even on a cache hit: that is what registers the
        // reading view's observation dependency. Without it, a cached read
        // would silently stop re-rendering when the list changes.
        let sessions = self.sessions
        let names = workspaceNames
        if let cached = sidebarRowsCache { return cached }
        let rows = Self.sidebarRows(in: sessions, workspaceNames: names)
        sidebarRowsCache = rows
        return rows
    }

    /// The one way to replace the list — keeps the grouping cache honest.
    ///
    /// `rows` is the grouping for `next` when the caller already has it;
    /// passing nil leaves the next read to group lazily. Publishing both in
    /// one step matters: assigning `sessions` alone wakes every observing
    /// view immediately, and a body that runs before the grouping lands is
    /// exactly the main-thread pass this cache exists to avoid.
    private func setSessions(_ next: [Session], rows: [SidebarWorkspace]? = nil) {
        sessions = next
        sidebarRowsCache = rows
        sessionsRevision += 1
    }

    private func setWorkspaceNames(_ next: [String: String]) {
        workspaceNames = next
        sidebarRowsCache = nil
        sessionsRevision += 1
    }

    /// Group a list off the main actor, ready to publish with it. The session
    /// titles that label `bks-…` links in transcripts are built in the same
    /// detached pass — it walks every row already, and doing it on the main
    /// actor would put another thousands-of-rows loop in the 5s poll.
    private static func groupedOffMain(
        _ sessions: [Session], workspaceNames names: [String: String]
    ) async -> (rows: [SidebarWorkspace], titles: [String: String]) {
        await Task.detached(priority: .userInitiated) {
            var titles: [String: String] = [:]
            titles.reserveCapacity(sessions.count)
            for session in sessions {
                let title = session.displayTitle
                if !title.isEmpty { titles[session.id] = title }
            }
            return (sidebarRows(in: sessions, workspaceNames: names), titles)
        }.value
    }

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

    /// The chat that takes over the strip when `closed` is closed from it: the
    /// tab to its right, or the one to its left when it was the rightmost. Nil
    /// when it was the workspace's last chat and there is nothing left to show.
    nonisolated static func tabAfterClosing(
        _ closed: Session, in tabs: [Session]
    ) -> Session? {
        let remaining = tabs.filter { $0.id != closed.id }
        guard !remaining.isEmpty else { return nil }
        let index = tabs.firstIndex { $0.id == closed.id } ?? 0
        return index < remaining.count ? remaining[index] : remaining.last
    }

    /// The sidebar's rows on this platform: workspace groups on iOS, and one
    /// row per chat on the Mac, whose detail has no sibling-tab strip yet.
    nonisolated static func sidebarRows(
        in sessions: [Session],
        workspaceNames: [String: String]
    ) -> [SidebarWorkspace] {
        #if os(macOS)
        return sessions.filter { $0.sideChatOf == nil }.map {
            SidebarWorkspace(
                id: "session:\($0.id)",
                title: $0.displayTitle,
                sessions: [$0],
                mainSession: $0
            )
        }
        #else
        return sidebarWorkspaces(in: sessions, workspaceNames: workspaceNames)
        #endif
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

    /// Workspace rows split into the web sidebar's Inbox bands. The bands are
    /// exclusive, with priority needs-action > live-or-today > yesterday >
    /// earlier, and every band ranks by last activity — deliberately ignoring
    /// the "Created" sort, since an inbox orders by what moved last. Empty
    /// bands are dropped.
    nonisolated static func inboxBands(
        _ workspaces: [SidebarWorkspace],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [(band: InboxBand, workspaces: [SidebarWorkspace])] {
        let dayStart = calendar.startOfDay(for: now)
        let yesterdayStart = dayStart.addingTimeInterval(-24 * 60 * 60)
        // Decorated: each row's activity date is derived once (it walks the
        // row's chats), not once per comparison — this runs on every body
        // evaluation over a list that can be thousands of rows.
        var bucketed: [InboxBand: [(workspace: SidebarWorkspace, date: Date)]] = [:]
        for workspace in workspaces {
            let date = workspace.lastActivityDate
            let band: InboxBand
            if workspace.lane == .needsInput {
                band = .needsAction
            } else if workspace.isRunning || date >= dayStart {
                // A live row is recent whatever its day — work in flight is
                // recent by definition — but ranks by activity like the rest.
                band = .recent
            } else if date >= yesterdayStart {
                band = .yesterday
            } else {
                band = .earlier
            }
            bucketed[band, default: []].append((workspace, date))
        }
        return InboxBand.allCases.compactMap { band in
            guard let rows = bucketed[band] else { return nil }
            return (band, rows.sorted { $0.date > $1.date }.map(\.workspace))
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
        setSessions(mergeOptimistic(into: sessions))
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
        setSessions(sessions.map { $0.id == tempId ? real : $0 })
    }

    /// Roll back a pending row whose create failed.
    func removeOptimistic(_ id: String) {
        optimistic.removeValue(forKey: id)
        setSessions(sessions.filter { $0.id != id })
    }

    /// Sessions archived locally that the server's (2s-cached) list may still
    /// include for a poll or two — suppressed until it catches up, with a
    /// safety expiry so a failed archive doesn't hide the row forever.
    private var locallyArchived: [String: (session: Session, added: Date)] = [:]

    /// Swipe-to-archive: drop the row immediately, tell the server in the
    /// background, and roll back (surfacing the error) if that fails.
    func archive(_ session: Session) {
        setSessions(sessions.filter { $0.id != session.id })
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
        setSessions([restored] + sessions)
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: false)
            } catch {
                locallyUnarchived.removeValue(forKey: session.id)
                setSessions(sessions.filter { $0.id != session.id })
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
                if nextNames != workspaceNames { setWorkspaceNames(nextNames) }
            }
            // Snapshot the main-actor state the filter needs, then do the
            // heavy pass (thousands of rows) off the main thread — inline it
            // ran on the main actor every 5s poll and hitched typing.
            let hiddenIds = Set(Array(locallyArchived.keys).filter { isLocallyArchived($0) })
            let restoredIds = Set(Array(locallyUnarchived.keys).filter { isLocallyUnarchived($0) })
            let localArchivedRows = hiddenIds.compactMap { locallyArchived[$0]?.session }
            let hideKeys = Set(HideStore.shared.hides.keys)
            let prepared = await Task.detached(priority: .userInitiated) {
                Self.prepared(
                    all,
                    hiding: hiddenIds,
                    restoring: restoredIds,
                    hidden: hideKeys
                )
            }.value
            // A hidden row comes back while one of its chats is blocked on a
            // question, and the entry is consumed when it does — so a hide can
            // never swallow work that needs you. Consuming it here (not in the
            // row filter) keeps the mutation out of view body evaluation.
            HideStore.shared.clear(prepared.resurfacedHideKeys)
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
            if next != sessions {
                // Group before publishing, not after: the assignment wakes
                // every observing view, so a grouping that starts afterwards
                // always loses the race to the body that needs it.
                let grouped = await Self.groupedOffMain(
                    next, workspaceNames: workspaceNames
                )
                SessionLinks.register(titles: grouped.titles)
                setSessions(next, rows: grouped.rows)
            }
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

    /// Drop archived/desk/locally-hidden rows and sort by last activity, and
    /// report which sidebar hides a blocked chat resurfaces.
    /// Decorated sort on purpose: the comparator form re-parsed each row's
    /// ISO date ~2·log n times, which multiplied into hundreds of
    /// milliseconds per poll at this list size — parse once per row instead.
    nonisolated static func prepared(
        _ all: [Session],
        hiding hiddenIds: Set<String>,
        restoring restoredIds: Set<String>,
        hidden hideKeys: Set<String> = []
    ) -> (active: [Session], archived: [Session], resurfacedHideKeys: [String]) {
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
        var resurfaced = Set<String>()
        if !hideKeys.isEmpty {
            for session in active where session.lane == .needsInput && !session.isAutomation {
                for key in HideStore.candidateKeys(for: session) where hideKeys.contains(key) {
                    resurfaced.insert(key)
                }
            }
        }
        return (active, archived, Array(resurfaced))
    }
}

/// The web sidebar's Inbox bands: an email-style split of the rows by when
/// they last moved, with "blocked on you" lifted out in front.
enum InboxBand: String, CaseIterable {
    case needsAction, recent, yesterday, earlier

    var label: String {
        switch self {
        case .needsAction: "Needs action"
        case .recent: "Recent"
        case .yesterday: "Yesterday"
        case .earlier: "Earlier"
        }
    }
}

struct SidebarWorkspace: Identifiable, Equatable, Sendable {
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
        sessions.contains(where: \.isOptimistic)
    }
    var effectiveRepo: String { mainSession.effectiveRepo }
    /// Any chat of the row is mid-turn — the row counts as live even when a
    /// blocked sibling owns its lane.
    var isRunning: Bool { sessions.contains { $0.isRunning == true } }
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
