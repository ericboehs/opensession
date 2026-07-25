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
    /// Non-nil opens the new-session sheet; carries the per-repo "+" preset.
    @State private var newSessionRequest: NewSessionRequest?
    /// Opening prompts (and images) of just-created sessions, keyed by id —
    /// seeds the conversation view so it renders instantly instead of waiting
    /// for the server to persist the session.
    @State private var optimisticSeeds: [String: SessionViewModel.OptimisticSeed] = [:]
    /// Surfaced when a background session create fails after the sheet closed.
    @State private var createError: String?

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
                .navigationTitle("Sessions")
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
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
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
        .safeAreaInset(edge: .bottom) {
            errorBanner
        }
    }
    #else
    private var navigationContainer: some View {
        NavigationStack(path: $path) {
            loadingOrList
                .navigationTitle("Sessions")
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
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
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
        } else if viewModel.sessions.isEmpty {
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
        Array(Set(viewModel.sessions.compactMap(\.repo))).sorted()
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

    private var filteredSessions: [Session] {
        var result = viewModel.sessions
        if peopleFilter == "mine" {
            result = result.filter(isMine)
        }
        if repoFilter != "all" {
            result = result.filter { $0.repo == repoFilter }
        }
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if !query.isEmpty {
            result = result.filter { session in
                for term in [session.title, session.repo, session.branch, session.id] {
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
            let byRepo = Dictionary(grouping: sessions) { $0.repo ?? "no repo" }
            return byRepo.keys.sorted().map {
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
            Image(
                systemName: repoFilter == "all"
                    ? "line.3.horizontal.decrease.circle"
                    : "line.3.horizontal.decrease.circle.fill"
            )
        }
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
        .insetGroupedListCompat()
        .searchable(text: $searchText, prompt: "Search sessions")
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
        NavigationLink(value: session) {
            SessionRow(session: session)
        }
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
                Label("Archive", systemImage: "archivebox")
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
        ForEach(groups) { group in
            Section {
                ForEach(group.sessions) { session in
                    sessionRow(session)
                }
            } header: {
                if !group.title.isEmpty {
                    HStack(spacing: 6) {
                        if groupBy == .status,
                           let lane = Session.Lane(rawValue: String(group.id.dropFirst("lane-".count))) {
                            Circle()
                                .fill(lane.color)
                                .frame(width: 7, height: 7)
                        }
                        Text(group.title)
                        Text("\(group.sessions.count)")
                            .foregroundStyle(.tertiary)
                        if groupBy == .repo {
                            // New session directly in this repo — inline next
                            // to the name rather than pushed flush against
                            // the panel's far edge.
                            Button {
                                newSessionRequest = NewSessionRequest(
                                    repo: group.title == "no repo" ? nil : group.title
                                )
                            } label: {
                                Image(systemName: "plus.circle")
                                    .font(.system(size: 14))
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var emptyFilterOverlay: some View {
        if groups.isEmpty {
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
            Button("Settings") { showSettings = true }
        }
    }
}

extension Session.Lane {
    /// Dot colors matching the web sidebar's lane dots.
    var color: Color {
        switch self {
        case .needsInput: .blue
        case .inProgress: .yellow
        case .inReview: .green
        case .done: .purple
        case .backlog: .secondary.opacity(0.4)
        }
    }
}

struct SessionRow: View {
    let session: Session
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
                        Image(systemName: "archivebox")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Archive")
                    // Sit on an opaque-ish pad so it reads over the meta line.
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

    private var content: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                statusDot
                Text(session.displayTitle)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
            }
            HStack(spacing: 6) {
                if let repo = session.repo {
                    Text(repo)
                }
                if let branch = session.branch {
                    Text(branch)
                        .lineLimit(1)
                }
                if session.prState == "OPEN" {
                    metaChip("PR open", tint: .green)
                }
                if session.queuedCount ?? 0 > 0 {
                    metaChip("+\(session.queuedCount!) queued", tint: .secondary)
                }
                Spacer()
                if let date = session.lastActivityDate {
                    Text(date, format: .relative(presentation: .named))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }

    private var statusDot: some View {
        // A running session's dot pulses (like the web sidebar) so in-flight
        // work is visible at a glance.
        PulsingDot(color: session.lane.color, active: session.lane == .inProgress)
    }

    /// Tiny tinted capsule for row badges (PR state, queued count).
    private func metaChip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12), in: Capsule())
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
