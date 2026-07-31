import Combine
import SwiftUI

/// Sessions list, mirroring the web sidebar's organization: group by Status
/// (In progress / Needs input / In review / Done / Backlog), by Repo, by Repo
/// and Status, or a flat Recent list — plus a repo filter, sort, and search.
/// The grouping/filter choices persist like the web's filter popover does.
struct SessionsListView: View {
    enum GroupBy: String, CaseIterable {
        case status, repo
        case repoStatus = "repo-status"
        case recent

        var label: String {
            switch self {
            case .status: "Status"
            case .repo: "Repo"
            case .repoStatus: "Repo and status"
            case .recent: "Recently active"
            }
        }
    }

    enum SortBy: String, CaseIterable {
        case updated, created

        var label: String {
            switch self {
            case .updated: "Last activity"
            case .created: "Created"
            }
        }
    }

    @State private var viewModel = SessionsListViewModel()
    @State private var showSettings = false
    @State private var path = NavigationPath()
    @State private var searchText = ""
    /// Non-nil opens the new-session sheet; carries the per-repo "+" preset.
    @State private var newSessionRequest: NewSessionRequest?
    /// Opening prompts (and images) of just-created sessions, keyed by id —
    /// seeds the conversation view so it renders instantly instead of waiting
    /// for the server to persist the session.
    @State private var optimisticSeeds: [String: SessionViewModel.OptimisticSeed] = [:]
    /// Unsent composer state survives switching sibling tabs (whose
    /// SessionViewModel/socket is otherwise deliberately recreated).
    @State private var composerDrafts: [String: SessionViewModel.ComposerDraft] = [:]
    /// Temp IDs remain aliases through the outgoing view's onDisappear so a
    /// draft edited while session creation resolves is saved under the real ID.
    @State private var resolvedSessionIds: [String: String] = [:]
    /// Loaded transcripts for recently visited mobile conversations. The
    /// cache is bounded and cached view models disconnect while off-screen.
    @State private var sessionPageCache = SessionViewModelCache()
    /// Surfaced when a background session create fails after the sheet closed.
    @State private var createError: String?
    @State private var showArchived = false
    #if os(iOS)
    @State private var renamingWorkspace: SidebarWorkspace?
    @State private var renameText = ""
    @State private var detailsWorkspace: SidebarWorkspace?
    #endif

    struct NewSessionRequest: Identifiable {
        let id = UUID()
        var repo: String?
    }

    @AppStorage("os1.list.groupBy") private var groupByRaw = GroupBy.repoStatus.rawValue
    @AppStorage("os1.list.repo") private var repoFilter = "all"
    @AppStorage("os1.list.sort") private var sortByRaw = SortBy.updated.rawValue
    // Default to the signed-in person's own sessions, like the web sidebar —
    // the server also hosts hundreds of automation runs and teammates' chats.
    @AppStorage("os1.list.people") private var peopleFilter = "mine"
    @AppStorage("os1.sidebar.repoOrder") private var preferredRepoOrder = "[]"

    private var groupBy: GroupBy { GroupBy(rawValue: groupByRaw) ?? .repoStatus }
    private var sortBy: SortBy { SortBy(rawValue: sortByRaw) ?? .updated }

    #if os(macOS)
    @State private var selectedSessionID: String?
    #else
    /// Temp id of the pending session pushed onto the stack, so the resolved
    /// real session can swap in place (and a failed create can pop it).
    @State private var pushedPendingId: String?
    #endif

    var body: some View {
        navigationContainer
            .task {
                viewModel.startPolling()
            }
            .onDisappear {
                viewModel.stopPolling()
            }
            .onChange(of: sessionCacheScope) {
                sessionPageCache.removeAll()
            }
            #if os(macOS)
            // File > New Session (Cmd+N) from the app's menu commands.
            .onReceive(NotificationCenter.default.publisher(for: .os1NewSession)) { _ in
                newSessionRequest = NewSessionRequest()
            }
            #endif
            .onChange(of: viewModel.hasLoaded) {
                autoOpenFromEnvironment()
            }
            .alert(
                "Couldn't start session",
                isPresented: Binding(
                    get: { createError != nil },
                    set: { if !$0 { createError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(createError ?? "")
            }
            #if os(iOS)
            .alert(
                "Rename workspace",
                isPresented: Binding(
                    get: { renamingWorkspace != nil },
                    set: { if !$0 { renamingWorkspace = nil } }
                ),
                presenting: renamingWorkspace
            ) { workspace in
                TextField("Workspace name", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    viewModel.rename(workspace, to: renameText)
                }
                .disabled(
                    workspace.projectId != nil
                        && renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            } message: { _ in
                Text("Choose a name for this workspace.")
            }
            .sheet(item: $detailsWorkspace) { workspace in
                WorktreeInfoSheet(workspace: workspace, listViewModel: viewModel)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            #endif
    }

    #if os(macOS)
    /// Mac: sessions live in a sidebar and the selected one opens in the
    /// detail column (like the web app), instead of iOS push navigation.
    private var navigationContainer: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                macSidebarHeader
                Divider()
                loadingOrList
            }
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            if let selectedSessionID,
               let session = viewModel.sessions.first(where: { $0.id == selectedSessionID }) {
                SessionView(session: session, seed: optimisticSeeds[session.id])
                    // Fresh view (and socket) per session, not a reused one.
                    .id(selectedSessionID)
            } else {
                ContentUnavailableView(
                    "Select a session",
                    systemImage: "bubble.left.and.bubble.right"
                )
            }
        }
        .sheet(item: $newSessionRequest) { request in
            NewSessionView(initialRepo: request.repo) { session, seed in
                openOptimistic(session, seed: seed)
            } onResolved: { tempId, result in
                resolveCreate(tempId: tempId, result: result)
            }
        }
        .sheet(isPresented: $showArchived) {
            ArchivedSessionsView(
                sessions: visibleArchivedSessions,
                onRestore: viewModel.unarchive
            )
        }
        .safeAreaInset(edge: .bottom) {
            errorBanner
        }
    }

    /// A stable in-sidebar hierarchy avoids three unrelated icon buttons
    /// floating in the unified window toolbar. Settings remains available in
    /// the app menu (Cmd+,), where Mac users expect it.
    private var macSidebarHeader: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Text("Sessions")
                    .font(.headline)
                Text("\(viewModel.sessions.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(OS1VisualStyle.textFaint)
                Spacer(minLength: 8)
                filterMenu
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .controlSize(.small)
                    .help("Filter, group, and sort sessions")
                Button {
                    newSessionRequest = NewSessionRequest()
                } label: {
                    Label("New", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .help("New session (Command-N)")
            }

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                TextField("Search sessions", text: $searchText)
                    .textFieldStyle(.plain)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 9)
            .frame(height: 28)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 7))
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 11)
        .background(.bar)
    }
    #else
    private var navigationContainer: some View {
        NavigationStack(path: $path) {
            loadingOrList
                .inlineTitleBarCompat()
                .toolbar {
                    ToolbarItem(placement: .topLeadingCompat) {
                        Button {
                            showSettings = true
                        } label: {
                            RepoTile(
                                name: "backstage",
                                size: 44,
                                round: true,
                                showsFallback: false
                            )
                        }
                        .accessibilityLabel("Settings")
                        // Hiding the glass background leaves the padding the
                        // capsule reserved, so the bare tile sat at ~34pt while
                        // every visible thing under it — repo icons, status
                        // dots, PR glyphs — starts at 20pt. Pull it back onto
                        // that column.
                        .padding(.leading, -14)
                    }
                    // The bare app tile is the control; the toolbar's glass
                    // circle around it read as a stray border.
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItem(placement: .topTrailingCompat) {
                        filterMenu
                    }
                    // New session lives in the top bar; search moved into the
                    // system bottom search field, which owns the bottom edge.
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button {
                            newSessionRequest = NewSessionRequest()
                        } label: {
                            Image(systemName: "plus")
                                // Neutral, not the red accent: the plus is
                                // chrome, not an alert.
                                .foregroundStyle(OS1VisualStyle.text)
                        }
                        .accessibilityLabel("New session")
                    }
                }
                .sheet(isPresented: $showSettings) {
                    SettingsView()
                }
                .sheet(item: $newSessionRequest) { request in
                    NewSessionView(initialRepo: request.repo) { session, seed in
                        openOptimistic(session, seed: seed)
                    } onResolved: { tempId, result in
                        resolveCreate(tempId: tempId, result: result)
                    }
                }
                .sheet(isPresented: $showArchived) {
                    ArchivedSessionsView(
                        sessions: visibleArchivedSessions,
                        onRestore: viewModel.unarchive
                    )
                }
                .safeAreaInset(edge: .bottom) {
                    errorBanner
                }
        }
    }
    #endif

    @ViewBuilder
    private var loadingOrList: some View {
        if !viewModel.hasLoaded {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.sessions.isEmpty && viewModel.archivedSessions.isEmpty {
            emptyState
        } else {
            list
        }
    }

    /// Floating glass capsule, matching the session view's banner styling,
    /// instead of a full-width opaque bar.
    @ViewBuilder
    private var errorBanner: some View {
        if let error = viewModel.error {
            Text(error)
                .font(.footnote)
                .foregroundStyle(.red)
                .lineLimit(2)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .glassSurface(in: Capsule())
                .padding(.bottom, 8)
        }
    }

    /// Dev convenience for simulator runs: OS1_OPEN_SESSION=<id> jumps straight
    /// into that session once the list has loaded.
    private func autoOpenFromEnvironment() {
        guard let id = ProcessInfo.processInfo.environment["OS1_OPEN_SESSION"],
              let session = viewModel.sessions.first(where: { $0.id == id })
        else { return }
        #if os(macOS)
        if selectedSessionID == nil { selectedSessionID = session.id }
        #else
        if path.isEmpty { path.append(session) }
        #endif
    }

    /// The moment Start is tapped: an optimistic row (temporary `pending-` id)
    /// joins the list and the conversation view opens seeded from the prompt —
    /// no waiting on the server. `resolveCreate` swaps in the real id (or
    /// rolls back) when the background create finishes.
    private func openOptimistic(
        _ session: Session, seed: SessionViewModel.OptimisticSeed
    ) {
        viewModel.addOptimistic(session)
        optimisticSeeds[session.id] = seed
        #if os(macOS)
        selectedSessionID = session.id
        #else
        pushedPendingId = session.id
        path.append(session)
        #endif
    }

    /// The background create finished: move the pending row (and the open
    /// conversation) onto the server's real id, or roll the pending row back
    /// and surface the error.
    private func resolveCreate(tempId: String, result: Result<String, Error>) {
        switch result {
        case .success(let id):
            viewModel.resolveOptimistic(tempId: tempId, realId: id)
            sessionPageCache.remove(sessionId: tempId)
            resolvedSessionIds[tempId] = id
            if let seed = optimisticSeeds.removeValue(forKey: tempId) {
                optimisticSeeds[id] = seed
            }
            if let draft = composerDrafts.removeValue(forKey: tempId) {
                composerDrafts[id] = draft
            }
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = id }
            #else
            if pushedPendingId == tempId, !path.isEmpty,
               let session = viewModel.sessions.first(where: { $0.id == id }) {
                // Swap the pending push for the real session without a
                // visible pop/push double transition.
                var next = path
                next.removeLast()
                next.append(session)
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    path = next
                }
            }
            pushedPendingId = nil
            #endif
        case .failure(let error):
            viewModel.removeOptimistic(tempId)
            sessionPageCache.remove(sessionId: tempId)
            optimisticSeeds[tempId] = nil
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = nil }
            #else
            if pushedPendingId == tempId, !path.isEmpty {
                path.removeLast()
            }
            pushedPendingId = nil
            #endif
            createError = error.localizedDescription
        }
    }

    // ── Filtering / grouping ──────────────────────────────────────────────

    private var availableRepos: [String] {
        SessionsListViewModel.repositoryOrder(
            in: viewModel.sessions,
            preferredOrderJSON: preferredRepoOrder
        )
    }

    /// Identity strings that count as "me": display name, its first token
    /// (sessions store first names, e.g. "Jaap"), and the GitHub login.
    private var myNames: Set<String> {
        var names: Set<String> = []
        let user = ServerConfig.shared.userName.trimmingCharacters(in: .whitespaces)
        if !user.isEmpty {
            names.insert(user.lowercased())
            if let first = user.split(separator: " ").first {
                names.insert(first.lowercased())
            }
        }
        let login = ServerConfig.shared.githubLogin
        if !login.isEmpty { names.insert(login.lowercased()) }
        return names
    }

    private func isMine(_ session: Session) -> Bool {
        guard !session.isAutomation, let by = session.startedBy?.lowercased() else { return false }
        return myNames.contains(by)
    }

    private var visibleArchivedSessions: [Session] {
        viewModel.archivedSessions.filter { session in
            (peopleFilter != "mine" || isMine(session))
                && (repoFilter == "all" || session.effectiveRepo == repoFilter)
        }
    }

    private var filteredWorkspaces: [SidebarWorkspace] {
        var workspaces = allSidebarWorkspaces
        if peopleFilter == "mine" {
            workspaces = workspaces.filter { $0.sessions.contains(where: isMine) }
        }
        if repoFilter != "all" {
            workspaces = workspaces.filter { $0.effectiveRepo == repoFilter }
        }
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if !query.isEmpty {
            workspaces = workspaces.filter { workspace in
                if workspace.title.lowercased().contains(query) { return true }
                return workspace.sessions.contains { session in
                    [session.title, session.effectiveRepo, session.branch, session.id]
                        .compactMap { $0 }
                        .contains { $0.lowercased().contains(query) }
                }
            }
        }
        // Decorated sort: parse each row's date once, not once per
        // comparison — this runs on the main thread on every body
        // evaluation, and the list can be thousands of rows with the
        // people filter set to "everyone".
        return workspaces
            .map { workspace in
                (
                    workspace: workspace,
                    inProgress: workspace.lane == .inProgress,
                    date: sortBy == .updated
                        ? workspace.lastActivityDate
                        : workspace.createdDate
                )
            }
            .sorted {
                if $0.inProgress != $1.inProgress { return $0.inProgress }
                return $0.date > $1.date
            }
            .map(\.workspace)
    }

    private var allSidebarWorkspaces: [SidebarWorkspace] {
        #if os(macOS)
        // The Mac detail currently has no sibling-tab strip. Preserve its
        // existing one-chat rows until those tabs have a native Mac surface.
        viewModel.sessions.filter { $0.sideChatOf == nil }.map {
            SidebarWorkspace(
                id: "session:\($0.id)",
                title: $0.displayTitle,
                sessions: [$0],
                mainSession: $0
            )
        }
        #else
        SessionsListViewModel.sidebarWorkspaces(
            in: viewModel.sessions,
            workspaceNames: viewModel.workspaceNames
        )
        #endif
    }

    private struct SessionGroup: Identifiable {
        let id: String
        let title: String
        let workspaces: [SidebarWorkspace]
        let lane: Session.Lane?
        let repo: String?
    }

    private struct RepoSessionGroup: Identifiable {
        let repo: String
        let workspaces: [SidebarWorkspace]
        let lanes: [SessionGroup]

        var id: String { repo }
    }

    private var groups: [SessionGroup] {
        let workspaces = filteredWorkspaces
        switch groupBy {
        case .recent:
            return workspaces.isEmpty
                ? []
                : [SessionGroup(
                    id: "recent",
                    title: "",
                    workspaces: workspaces,
                    lane: nil,
                    repo: nil
                )]
        case .repo:
            let byRepo = Dictionary(grouping: workspaces, by: \.effectiveRepo)
            return availableRepos.filter { byRepo[$0] != nil }.map {
                SessionGroup(
                    id: "repo-\($0)",
                    title: $0,
                    workspaces: byRepo[$0]!,
                    lane: nil,
                    repo: $0
                )
            }
        case .status:
            return Session.Lane.allCases.compactMap { lane in
                let inLane = workspaces.filter { $0.lane == lane }
                return inLane.isEmpty
                    ? nil
                    : SessionGroup(
                        id: "lane-\(lane.rawValue)",
                        title: lane.label,
                        workspaces: inLane,
                        lane: lane,
                        repo: nil
                    )
            }
        case .repoStatus:
            return []
        }
    }

    private var repoSessionGroups: [RepoSessionGroup] {
        let byRepo = Dictionary(grouping: filteredWorkspaces, by: \.effectiveRepo)
        return availableRepos.compactMap { repo in
            guard let workspaces = byRepo[repo] else { return nil }
            let lanes = Session.Lane.allCases.compactMap { lane in
                let inLane = workspaces.filter { $0.lane == lane }
                return inLane.isEmpty
                    ? nil
                    : SessionGroup(
                        id: "repo-\(repo)-lane-\(lane.rawValue)",
                        title: lane.label,
                        workspaces: inLane,
                        lane: lane,
                        repo: nil
                    )
            }
            return RepoSessionGroup(repo: repo, workspaces: workspaces, lanes: lanes)
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $peopleFilter) {
                Text("My sessions").tag("mine")
                Text("Everyone").tag("all")
            }
            Picker("Group by", selection: $groupByRaw) {
                ForEach(GroupBy.allCases, id: \.rawValue) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            Picker("Repo", selection: $repoFilter) {
                Text("All repos").tag("all")
                ForEach(availableRepos, id: \.self) { repo in
                    Text(repo).tag(repo)
                }
            }
            .pickerStyle(.menu)
            Picker("Sort by", selection: $sortByRaw) {
                ForEach(SortBy.allCases, id: \.rawValue) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
        } label: {
            #if os(macOS)
            Image(
                systemName: repoFilter == "all"
                    ? "line.3.horizontal.decrease"
                    : "line.3.horizontal.decrease.circle.fill"
            )
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(repoFilter == "all" ? OS1VisualStyle.textDim : OS1VisualStyle.accent)
            .frame(width: 26, height: 24)
            .contentShape(Rectangle())
            #else
            WebIcon(
                kind: .filter,
                size: 24,
                color: repoFilter == "all"
                    ? OS1VisualStyle.textDim
                    : OS1VisualStyle.accent
            )
            #endif
        }
        .accessibilityLabel("Filter sessions")
        .accessibilityValue(filterAccessibilityValue)
    }

    private var filterAccessibilityValue: String {
        let people = peopleFilter == "mine" ? "My sessions" : "Everyone"
        let repo = repoFilter == "all" ? "All repositories" : RepoTile.label(for: repoFilter)
        return "\(people), grouped by \(groupBy.label), \(repo), sorted by \(sortBy.label)"
    }

    // ── List body ─────────────────────────────────────────────────────────

    #if os(macOS)
    private var list: some View {
        List(selection: $selectedSessionID) {
            listSections
        }
        .listStyle(.sidebar)
        .overlay { emptyFilterOverlay }
        // Delete key archives the selected session — the Mac-native
        // counterpart to iOS's swipe.
        .onDeleteCommand {
            if let selectedSessionID,
               let workspace = allSidebarWorkspaces.first(where: {
                   $0.sessions.contains { $0.id == selectedSessionID }
               }) {
                archive(workspace)
            }
        }
    }
    #else
    private var list: some View {
        List {
            listSections
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .listSectionSpacing(10)
        .contentMargins(.top, 4, for: .scrollContent)
        // The system search field: iOS 26 places it at the bottom edge on
        // iPhone (the Liquid Glass search treatment), replacing the old
        // toolbar toggle + inline field.
        .searchable(text: $searchText, prompt: "Search sessions")
        .overlay { emptyFilterOverlay }
        .refreshable {
            await viewModel.refresh()
        }
        .navigationDestination(for: Session.self) { session in
            SessionTabsView(
                session: session,
                tabs: SessionsListViewModel.tabSessions(
                    in: viewModel.sessions,
                    containing: session
                ),
                viewModelForSession: {
                    sessionPageCache.viewModel(
                        for: $0,
                        scope: sessionCacheScope,
                        seed: optimisticSeeds[$0.id],
                        composerDraft: composerDrafts[$0.id]
                    )
                },
                onSaveComposerDraft: { savedSession, draft in
                    let id = resolvedSessionIds[savedSession.id] ?? savedSession.id
                    composerDrafts[id] = draft.isEmpty ? nil : draft
                },
                onNewSession: {
                    newSessionRequest = NewSessionRequest(repo: session.effectiveRepo)
                }
            )
            .id(session.id)
        }
    }
    #endif

    @ViewBuilder
    private func sessionRow(_ workspace: SidebarWorkspace) -> some View {
        let session = workspace.mainSession
        let canArchive = !workspace.isOptimistic
        #if os(macOS)
        // Selection drives the detail column; select by id so rows replaced
        // by polling (fresh struct values every refresh) keep the selection.
        // Archiving is Mac-idiomatic here: hover button on the row, context
        // menu, and the Delete key — swipe also works but isn't the primary.
        SessionRow(
            session: workspace.statusSession,
            title: workspace.title,
            onArchive: canArchive ? { archive(workspace) } : nil
        )
        .tag(session.id)
        .swipeActions(edge: .trailing) { archiveButton(workspace, viaSwipe: true) }
        .contextMenu { archiveButton(workspace) }
        #else
        Button {
            path.append(session)
        } label: {
            SessionRow(session: workspace.statusSession, title: workspace.title)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .trailing) { archiveButton(workspace, viaSwipe: true) }
        .contextMenu {
            if canArchive { workspaceMenu(workspace) }
        }
        #endif
    }

    #if os(iOS)
    @ViewBuilder
    private func workspaceMenu(_ workspace: SidebarWorkspace) -> some View {
        Button {
            detailsWorkspace = workspace
        } label: {
            Label("Worktree details", systemImage: "info.circle")
        }

        Button {
            renameText = workspace.title
            renamingWorkspace = workspace
        } label: {
            Label("Rename", systemImage: "pencil")
        }

        if let link = workspaceLink(workspace) {
            ShareLink(item: link) {
                Label("Share link", systemImage: "square.and.arrow.up")
            }
        }

        let prLink = workspace.statusSession.prUrl ?? workspace.sessions.compactMap(\.prUrl).first
        if let prURL = prLink.flatMap(URL.init(string:)) {
            Link(destination: prURL) {
                Label("Open pull request", systemImage: "arrow.triangle.pull")
            }
        }

        if !workspace.isOptimistic {
            Divider()
            Button(role: .destructive) {
                archive(workspace)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
    }

    private func workspaceLink(_ workspace: SidebarWorkspace) -> URL? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        let session = workspace.mainSession
        if let projectId = session.projectId, !projectId.isEmpty {
            return base
                .appendingPathComponent("workspace")
                .appendingPathComponent(projectId)
                .appendingPathComponent("chat")
                .appendingPathComponent(session.id)
        }
        return base
            .appendingPathComponent("session")
            .appendingPathComponent(session.id)
    }
    #endif

    /// Trailing swipe (and Mac context-menu) action. Hidden for optimistic
    /// rows — even after create returns a real id, the server may not have
    /// exposed the session through its cached list yet.
    ///
    /// The swipe variant is `role: .destructive` and skips our own
    /// `withAnimation`: the destructive role tells the List the row is going
    /// away, so a full swipe runs the system's native delete choreography
    /// (row slides off, neighbors close up). A non-destructive button first
    /// snaps the cell shut and then our animation re-ran the whole
    /// inset-grouped section reflow — visibly morphing iOS 26's
    /// position-dependent corner radii at our curve's pace.
    @ViewBuilder
    private func archiveButton(
        _ workspace: SidebarWorkspace,
        viaSwipe: Bool = false
    ) -> some View {
        if !workspace.isOptimistic {
            Button(role: viaSwipe ? .destructive : nil) {
                archive(workspace, animated: !viaSwipe)
            } label: {
                VStack(spacing: 2) {
                    WebIcon(kind: .archive, size: 22, color: .white)
                    Text("Archive")
                }
            }
            .tint(.purple)
        }
    }

    private func archive(_ workspace: SidebarWorkspace, animated: Bool = true) {
        workspace.sessions.forEach {
            sessionPageCache.remove(sessionId: $0.id)
        }
        #if os(macOS)
        if workspace.sessions.contains(where: { $0.id == selectedSessionID }) {
            selectedSessionID = nil
        }
        #endif
        if animated {
            // Mac hover button / Delete key / context menu: collapse the row
            // instead of blinking it out.
            withAnimation(.snappy(duration: 0.28)) {
                workspace.sessions.forEach(viewModel.archive)
            }
        } else {
            // Swipe path: the List's destructive-role delete animation owns
            // the removal; wrapping the mutation would fight it.
            workspace.sessions.forEach(viewModel.archive)
        }
    }

    private var sessionCacheScope: SessionViewModelCache.Scope {
        let config = ServerConfig.shared
        return SessionViewModelCache.Scope(
            serverURL: config.baseURLString,
            token: config.token
        )
    }

    private var listSections: some View {
        Group {
            if groupBy == .repoStatus {
                ForEach(repoSessionGroups) { repoGroup in
                    Section {
                        ForEach(repoGroup.lanes) { laneGroup in
                            statusLaneHeader(laneGroup)
                            ForEach(laneGroup.workspaces) { workspace in
                                sessionRow(workspace)
                            }
                        }
                    } header: {
                        groupHeader(
                            title: repoGroup.repo,
                            count: repoGroup.workspaces.count,
                            repo: repoGroup.repo
                        )
                    }
                }
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.workspaces) { workspace in
                            sessionRow(workspace)
                        }
                    } header: {
                        if !group.title.isEmpty {
                            groupHeader(
                                title: group.title,
                                count: group.workspaces.count,
                                lane: group.lane,
                                repo: group.repo
                            )
                        }
                    }
                }
            }

            if !visibleArchivedSessions.isEmpty {
                Section {
                    Button {
                        showArchived = true
                    } label: {
                        HStack(spacing: 9) {
                            #if os(iOS)
                            WebIcon(kind: .archive, size: 22, color: OS1VisualStyle.textDim)
                                .frame(width: 22, height: 22)
                            #else
                            WebIcon(kind: .archive, size: 16, color: OS1VisualStyle.textDim)
                                .frame(width: 16, height: 16)
                            #endif
                            Text("Archived")
                                #if os(iOS)
                                .font(.body.weight(.medium))
                                #else
                                .font(.body)
                                #endif
                                .foregroundStyle(OS1VisualStyle.textDim)
                            Spacer()
                            Text("\(visibleArchivedSessions.count)")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                        #if os(iOS)
                        .padding(.vertical, 9)
                        #else
                        .padding(.vertical, 3)
                        #endif
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    #if os(iOS)
                    .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    #endif
                }
            }
        }
    }

    @ViewBuilder
    private var emptyFilterOverlay: some View {
        if filteredWorkspaces.isEmpty && visibleArchivedSessions.isEmpty {
            if !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if peopleFilter == "mine" {
                ContentUnavailableView {
                    Label("No sessions of yours yet", systemImage: "person.crop.circle")
                } description: {
                    Text("Sessions you start appear here.")
                } actions: {
                    Button("New session") {
                        newSessionRequest = NewSessionRequest()
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Show everyone's") { peopleFilter = "all" }
                }
            }
        }
    }

    private func groupHeader(
        title: String,
        count: Int,
        lane: Session.Lane? = nil,
        repo: String? = nil
    ) -> some View {
        HStack(spacing: 6) {
            if let lane {
                Circle()
                    .fill(lane.color)
                    .frame(width: 7, height: 7)
            }
            if let repo {
                #if os(iOS)
                RepoTile(name: repo, size: 24)
                #else
                RepoTile(name: repo)
                #endif
            }
            Text(repo.map { RepoTile.label(for: $0) } ?? title)
                #if os(iOS)
                .font(.subheadline.weight(.semibold))
                #else
                .font(.caption.weight(.semibold))
                #endif
                .foregroundStyle(OS1VisualStyle.textDim)
            Text("\(count)")
                #if os(iOS)
                .font(.footnote.weight(.medium))
                #else
                .font(.caption.monospacedDigit())
                #endif
                .foregroundStyle(OS1VisualStyle.textDim)
            if let repo {
                Spacer(minLength: 8)
                Button {
                    newSessionRequest = NewSessionRequest(repo: repo)
                } label: {
                    Image(systemName: "plus")
                        #if os(iOS)
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 30, height: 30)
                        #else
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 20, height: 20)
                        #endif
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("New session in \(RepoTile.label(for: repo))")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textCase(nil)
        .padding(.top, 4)
    }

    private func statusLaneHeader(_ group: SessionGroup) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(group.lane?.color ?? OS1VisualStyle.textFaint)
                .frame(width: 6, height: 6)
            Text(group.title)
                .font(.caption.weight(.semibold))
            Text("\(group.workspaces.count)")
                .font(.caption2.monospacedDigit())
        }
        .foregroundStyle(OS1VisualStyle.textDim)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityElement(children: .combine)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No sessions", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text(viewModel.error ?? "Sessions from the OS1 server will appear here.")
        } actions: {
            #if os(macOS)
            SettingsLink { Text("Settings") }
            #else
            Button("Settings") { showSettings = true }
            #endif
        }
    }
}

private struct ArchivedSessionsView: View {
    let sessions: [Session]
    let onRestore: (Session) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if sessions.isEmpty {
                    ContentUnavailableView(
                        "Nothing archived",
                        systemImage: "archivebox"
                    )
                } else {
                    ForEach(sessions) { session in
                        HStack(spacing: 10) {
                            RepoTile(name: session.effectiveRepo, size: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.displayTitle)
                                    .font(.body.weight(.medium))
                                    .lineLimit(2)
                                Text(RepoTile.label(for: session.effectiveRepo))
                                    .font(.footnote)
                                    .foregroundStyle(OS1VisualStyle.textDim)
                            }
                            Spacer(minLength: 8)
                            Button {
                                onRestore(session)
                            } label: {
                                HStack(spacing: 5) {
                                    WebIcon(kind: .unarchive, size: 18)
                                    Text("Restore")
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            #if os(iOS)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            #endif
            .navigationTitle("Archived")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

extension Session.Lane {
    /// Dot colors matching the web sidebar's lane dots.
    var color: Color {
        switch self {
        case .needsInput: OS1VisualStyle.blue
        case .inProgress: OS1VisualStyle.yellow
        case .inReview: OS1VisualStyle.green
        case .done: OS1VisualStyle.purple
        case .backlog: OS1VisualStyle.textFaint.opacity(0.7)
        }
    }
}

struct SessionRow: View {
    let session: Session
    var title: String? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Mac: hover-revealed archive button (nil hides it).
    var onArchive: (() -> Void)? = nil

    #if os(macOS)
    @State private var hovering = false
    #endif

    var body: some View {
        #if os(macOS)
        content
            .overlay(alignment: .trailing) {
                if hovering, let onArchive {
                    Button(action: onArchive) {
                        WebIcon(kind: .archive, size: 20, color: .secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Archive")
                    // Keep the action legible over a long title.
                    .padding(4)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 5))
                }
            }
            // onHover must wrap the overlay, not sit under it: with the button
            // on top of the hover target, reaching it ended the content's
            // hover, which unmounted the button under the cursor (flicker).
            .onHover { hovering = $0 }
        #else
        content
        #endif
    }

    /// Mac sidebar rows are compact and body-sized like Finder/System
    /// Settings; iOS keeps the roomier touch metrics.
    private var content: some View {
        HStack(spacing: 9) {
            statusMark
                .frame(width: markSize, height: markSize)
            Text(rowTitle)
                #if os(iOS)
                .font(.body.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                #else
                .font(.body)
                .foregroundStyle(.primary)
                #endif
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if session.lane == .inProgress && showsElapsedTime {
                WorkspaceRunElapsedLabel(since: session.runStartedDate)
            }
        }
        #if os(iOS)
        .padding(.vertical, 11)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rowTitle)
        .accessibilityValue(accessibilityStatus)
        #if os(macOS)
        .help(rowTitle)
        #endif
    }

    private var markSize: CGFloat {
        #if os(iOS)
        22
        #else
        14
        #endif
    }

    private var rowTitle: String {
        (title ?? session.displayTitle).replacingOccurrences(
            of: #"^PR\s*#\d+(:|\s*[—–-])\s*"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
    }

    private var showsElapsedTime: Bool {
        #if os(iOS)
        !dynamicTypeSize.isAccessibilitySize
        #else
        true
        #endif
    }

    @ViewBuilder
    private var statusMark: some View {
        if session.lane == .needsInput {
            PulsingDot(color: OS1VisualStyle.blue, active: animatesStatus)
        } else if session.lane == .inProgress {
            PulsingDot(color: OS1VisualStyle.yellow, active: animatesStatus)
        } else if session.prState == "MERGED" {
            WebIcon(kind: .gitMerge, size: markSize, color: OS1VisualStyle.purple)
        } else if session.prState == "OPEN" {
            WebIcon(kind: .pullRequest, size: markSize, color: OS1VisualStyle.green)
        } else if session.prState == "CLOSED" {
            WebIcon(kind: .pullRequest, size: markSize, color: OS1VisualStyle.red)
        } else {
            PulsingDot(color: OS1VisualStyle.textFaint, active: false)
        }
    }

    private var animatesStatus: Bool {
        #if os(iOS)
        true
        #else
        false
        #endif
    }

    private var accessibilityStatus: String {
        var parts = [session.lane.label, RepoTile.label(for: session.effectiveRepo)]
        if let prState = session.prState?.lowercased() {
            parts.append("pull request \(prState)")
        }
        return parts.joined(separator: ", ")
    }
}

/// Web workspace rows reserve their trailing slot for a live run clock; idle
/// rows intentionally show no last-used timestamp.
private struct WorkspaceRunElapsedLabel: View {
    let since: Date?

    var body: some View {
        Group {
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(label(context.date.timeIntervalSince(since)))
                }
            } else {
                Text("Running")
            }
        }
        #if os(iOS)
        .font(.footnote.weight(.medium).monospacedDigit())
        #else
        .font(.caption.monospacedDigit())
        #endif
        .foregroundStyle(OS1VisualStyle.yellow)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func label(_ elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed))
        if total < 60 { return "\(total)s" }
        if total < 3_600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3_600)h \((total % 3_600) / 60)m"
    }
}

/// Status dot that softly pulses while `active` — mirrors the web's
/// `.pulse-dot` (1.4s opacity cycle).
struct PulsingDot: View {
    let color: Color
    var active: Bool = true
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let dot = Circle()
            .fill(color)
            .frame(width: size, height: size)
        if active && !reduceMotion {
            dot.phaseAnimator([1.0, 0.35]) { view, opacity in
                view.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.7)
            }
        } else {
            dot
        }
    }
}
