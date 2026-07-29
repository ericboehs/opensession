import Combine
import SwiftUI

/// Sessions list, mirroring the web sidebar's organization: group by Status
/// (In progress / Needs input / In review / Done / Backlog), by Repo, or a
/// flat Recent list — plus a repo filter, updated/created sort, and search.
/// The grouping/filter choices persist like the web's filter popover does.
struct SessionsListView: View {
    enum GroupBy: String, CaseIterable {
        case status, repo, recent

        var label: String {
            switch self {
            case .status: "Status"
            case .repo: "Repo"
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
    @State private var showingSearch = false
    @FocusState private var searchFocused: Bool
    /// Non-nil opens the new-session sheet; carries the per-repo "+" preset.
    @State private var newSessionRequest: NewSessionRequest?
    /// Opening prompts (and images) of just-created sessions, keyed by id —
    /// seeds the conversation view so it renders instantly instead of waiting
    /// for the server to persist the session.
    @State private var optimisticSeeds: [String: SessionViewModel.OptimisticSeed] = [:]
    /// Surfaced when a background session create fails after the sheet closed.
    @State private var createError: String?
    @State private var showArchived = false

    struct NewSessionRequest: Identifiable {
        let id = UUID()
        var repo: String?
    }

    @AppStorage("os1.list.groupBy") private var groupByRaw = GroupBy.status.rawValue
    @AppStorage("os1.list.repo") private var repoFilter = "all"
    @AppStorage("os1.list.sort") private var sortByRaw = SortBy.updated.rawValue
    // Default to the signed-in person's own sessions, like the web sidebar —
    // the server also hosts hundreds of automation runs and teammates' chats.
    @AppStorage("os1.list.people") private var peopleFilter = "mine"
    @AppStorage("os1.sidebar.repoOrder") private var preferredRepoOrder = "[]"

    private var groupBy: GroupBy { GroupBy(rawValue: groupByRaw) ?? .status }
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
    }

    #if os(macOS)
    /// Mac: sessions live in a sidebar and the selected one opens in the
    /// detail column (like the web app), instead of iOS push navigation.
    private var navigationContainer: some View {
        NavigationSplitView {
            loadingOrList
                .navigationTitle("Workspaces")
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
                .toolbar {
                    ToolbarItem(placement: .topLeadingCompat) {
                        filterMenu
                    }
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button {
                            newSessionRequest = NewSessionRequest()
                        } label: {
                            Image(systemName: "square.and.pencil")
                        }
                    }
                    ToolbarItem(placement: .topTrailingCompat) {
                        SettingsLink {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                }
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
                            RepoTile(name: "backstage", size: 34, round: true)
                        }
                        .accessibilityLabel("Settings")
                    }
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button {
                            withAnimation(.snappy(duration: 0.2)) {
                                showingSearch.toggle()
                            }
                        } label: {
                            WebIcon(
                                kind: .search,
                                size: 24,
                                color: showingSearch ? OS1VisualStyle.accent : OS1VisualStyle.textDim
                            )
                        }
                        .accessibilityLabel("Search")
                    }
                    ToolbarItem(placement: .topTrailingCompat) {
                        filterMenu
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if showingSearch {
                        inlineSearchField
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        newSessionRequest = NewSessionRequest()
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 24, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(width: 56, height: 56)
                            .background(OS1VisualStyle.accent, in: Circle())
                            .shadow(color: .black.opacity(0.28), radius: 12, y: 6)
                    }
                    .accessibilityLabel("New session")
                    .padding(.trailing, 18)
                    .padding(.bottom, 18)
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
                .onChange(of: showingSearch) { _, visible in
                    if visible { searchFocused = true }
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
            if let seed = optimisticSeeds.removeValue(forKey: tempId) {
                optimisticSeeds[id] = seed
            }
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = id }
            #else
            if pushedPendingId == tempId, !path.isEmpty,
               let session = viewModel.sessions.first(where: { $0.id == id }) {
                // Swap the pending push for the real session without a
                // visible pop/push double transition.
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    path.removeLast()
                    path.append(session)
                }
            }
            pushedPendingId = nil
            #endif
        case .failure(let error):
            viewModel.removeOptimistic(tempId)
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

    private var filteredSessions: [Session] {
        var result = viewModel.sessions
        if peopleFilter == "mine" {
            result = result.filter(isMine)
        }
        if repoFilter != "all" {
            result = result.filter { $0.effectiveRepo == repoFilter }
        }
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if !query.isEmpty {
            result = result.filter { session in
                for term in [session.title, session.effectiveRepo, session.branch, session.id] {
                    if let term, term.lowercased().contains(query) { return true }
                }
                return false
            }
        }
        // Decorated sort: parse each row's date once, not once per
        // comparison — this runs on the main thread on every body
        // evaluation, and the list can be thousands of rows with the
        // people filter set to "everyone".
        return result
            .map { session in
                (
                    session: session,
                    inProgress: session.lane == .inProgress,
                    date: sortBy == .updated
                        ? session.lastActivityDate ?? .distantPast
                        : Session.parseISO(session.createdAt) ?? .distantPast
                )
            }
            .sorted {
                if $0.inProgress != $1.inProgress { return $0.inProgress }
                return $0.date > $1.date
            }
            .map(\.session)
    }

    private struct SessionGroup: Identifiable {
        let id: String
        let title: String
        let sessions: [Session]
    }

    private var groups: [SessionGroup] {
        let sessions = filteredSessions
        switch groupBy {
        case .recent:
            return sessions.isEmpty ? [] : [SessionGroup(id: "recent", title: "", sessions: sessions)]
        case .repo:
            let byRepo = Dictionary(grouping: sessions, by: \.effectiveRepo)
            return availableRepos.filter { byRepo[$0] != nil }.map {
                SessionGroup(id: "repo-\($0)", title: $0, sessions: byRepo[$0]!)
            }
        case .status:
            return Session.Lane.allCases.compactMap { lane in
                let inLane = sessions.filter { $0.lane == lane }
                return inLane.isEmpty
                    ? nil
                    : SessionGroup(id: "lane-\(lane.rawValue)", title: lane.label, sessions: inLane)
            }
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
            WebIcon(
                kind: .filter,
                size: 24,
                color: repoFilter == "all"
                    ? OS1VisualStyle.textDim
                    : OS1VisualStyle.accent
            )
        }
    }

    private var inlineSearchField: some View {
        HStack(spacing: 10) {
            WebIcon(kind: .search, size: 22, color: OS1VisualStyle.textFaint)
            TextField("Search sessions", text: $searchText)
                .textFieldStyle(.plain)
                .font(.body)
                .focused($searchFocused)
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(OS1VisualStyle.textFaint)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(OS1VisualStyle.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(OS1VisualStyle.border, lineWidth: 0.5)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(OS1VisualStyle.background)
    }

    // ── List body ─────────────────────────────────────────────────────────

    #if os(macOS)
    private var list: some View {
        List(selection: $selectedSessionID) {
            listSections
        }
        .listStyle(.sidebar)
        .searchable(text: $searchText, prompt: "Search sessions")
        .overlay { emptyFilterOverlay }
        // Delete key archives the selected session — the Mac-native
        // counterpart to iOS's swipe.
        .onDeleteCommand {
            if let selectedSessionID,
               let session = viewModel.sessions.first(where: { $0.id == selectedSessionID }) {
                archive(session)
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
        .overlay { emptyFilterOverlay }
        .refreshable {
            await viewModel.refresh()
        }
        .navigationDestination(for: Session.self) { session in
            SessionView(session: session, seed: optimisticSeeds[session.id])
        }
    }
    #endif

    @ViewBuilder
    private func sessionRow(_ session: Session) -> some View {
        let canArchive = !session.id.hasPrefix("pending-")
        #if os(macOS)
        // Selection drives the detail column; select by id so rows replaced
        // by polling (fresh struct values every refresh) keep the selection.
        // Archiving is Mac-idiomatic here: hover button on the row, context
        // menu, and the Delete key — swipe also works but isn't the primary.
        SessionRow(
            session: session,
            onArchive: canArchive ? { archive(session) } : nil
        )
        .tag(session.id)
        .swipeActions(edge: .trailing) { archiveButton(session, viaSwipe: true) }
        .contextMenu { archiveButton(session) }
        #else
        Button {
            path.append(session)
        } label: {
            SessionRow(session: session)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .trailing) { archiveButton(session, viaSwipe: true) }
        #endif
    }

    /// Trailing swipe (and Mac context-menu) action. Hidden for optimistic
    /// `pending-` rows — the server doesn't know those ids yet.
    ///
    /// The swipe variant is `role: .destructive` and skips our own
    /// `withAnimation`: the destructive role tells the List the row is going
    /// away, so a full swipe runs the system's native delete choreography
    /// (row slides off, neighbors close up). A non-destructive button first
    /// snaps the cell shut and then our animation re-ran the whole
    /// inset-grouped section reflow — visibly morphing iOS 26's
    /// position-dependent corner radii at our curve's pace.
    @ViewBuilder
    private func archiveButton(_ session: Session, viaSwipe: Bool = false) -> some View {
        if !session.id.hasPrefix("pending-") {
            Button(role: viaSwipe ? .destructive : nil) {
                archive(session, animated: !viaSwipe)
            } label: {
                VStack(spacing: 2) {
                    WebIcon(kind: .archive, size: 22, color: .white)
                    Text("Archive")
                }
            }
            .tint(.purple)
        }
    }

    private func archive(_ session: Session, animated: Bool = true) {
        #if os(macOS)
        if selectedSessionID == session.id { selectedSessionID = nil }
        #endif
        if animated {
            // Mac hover button / Delete key / context menu: collapse the row
            // instead of blinking it out.
            withAnimation(.snappy(duration: 0.28)) {
                viewModel.archive(session)
            }
        } else {
            // Swipe path: the List's destructive-role delete animation owns
            // the removal; wrapping the mutation would fight it.
            viewModel.archive(session)
        }
    }

    private var listSections: some View {
        Group {
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { session in
                        sessionRow(session)
                    }
                } header: {
                    if !group.title.isEmpty {
                        HStack(spacing: 6) {
                            if groupBy == .status,
                               let lane = Session.Lane(
                                   rawValue: String(group.id.dropFirst("lane-".count))
                               ) {
                                Circle()
                                    .fill(lane.color)
                                    .frame(width: 7, height: 7)
                            }
                            if groupBy == .repo {
                                RepoTile(name: group.title)
                            }
                            Text(groupBy == .repo ? RepoTile.label(for: group.title) : group.title)
                                #if os(iOS)
                                .font(.subheadline.weight(.semibold))
                                #else
                                .font(.caption.weight(.semibold))
                                #endif
                                .foregroundStyle(OS1VisualStyle.textDim)
                            Text("\(group.sessions.count)")
                                #if os(iOS)
                                .font(.footnote.weight(.medium))
                                #else
                                .font(.caption)
                                #endif
                                .foregroundStyle(OS1VisualStyle.textDim)
                            if groupBy == .repo {
                                Spacer(minLength: 8)
                                Button {
                                    newSessionRequest = NewSessionRequest(repo: group.title)
                                } label: {
                                    Image(systemName: "plus")
                                        #if os(iOS)
                                        .font(.system(size: 18, weight: .medium))
                                        .frame(width: 30, height: 30)
                                        #else
                                        .font(.system(size: 12, weight: .medium))
                                        .frame(width: 20, height: 20)
                                        #endif
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel(
                                    "New session in \(RepoTile.label(for: group.title))"
                                )
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textCase(nil)
                        .padding(.top, 4)
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
        if groups.isEmpty && visibleArchivedSessions.isEmpty {
            if !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if peopleFilter == "mine" {
                ContentUnavailableView {
                    Label("No sessions of yours yet", systemImage: "person.crop.circle")
                } description: {
                    Text("Sessions you start appear here.")
                } actions: {
                    Button("Show everyone's") { peopleFilter = "all" }
                }
            }
        }
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
    }

    private var markSize: CGFloat {
        #if os(iOS)
        22
        #else
        16
        #endif
    }

    private var rowTitle: String {
        session.displayTitle.replacingOccurrences(
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
            PulsingDot(color: OS1VisualStyle.blue)
        } else if session.lane == .inProgress {
            PulsingDot(color: OS1VisualStyle.yellow)
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

    var body: some View {
        let dot = Circle()
            .fill(color)
            .frame(width: size, height: size)
        if active {
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
