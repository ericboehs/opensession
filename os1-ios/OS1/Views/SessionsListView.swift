import SwiftUI

/// Sessions list, mirroring the web sidebar's organization: group by Status
/// (Needs input / In progress / In review / Done / Backlog), by Repo, or a
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

    @AppStorage("os1.list.groupBy") private var groupByRaw = GroupBy.status.rawValue
    @AppStorage("os1.list.repo") private var repoFilter = "all"
    @AppStorage("os1.list.sort") private var sortByRaw = SortBy.updated.rawValue
    // Default to the signed-in person's own sessions, like the web sidebar —
    // the server also hosts hundreds of automation runs and teammates' chats.
    @AppStorage("os1.list.people") private var peopleFilter = "mine"

    private var groupBy: GroupBy { GroupBy(rawValue: groupByRaw) ?? .status }
    private var sortBy: SortBy { SortBy(rawValue: sortByRaw) ?? .updated }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if !viewModel.hasLoaded {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if viewModel.sessions.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) {
                    filterMenu
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
            .safeAreaInset(edge: .bottom) {
                if let error = viewModel.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(.red.opacity(0.85))
                }
            }
        }
        .task {
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
        .onChange(of: viewModel.hasLoaded) {
            autoOpenFromEnvironment()
        }
    }

    /// Dev convenience for simulator runs: OS1_OPEN_SESSION=<id> jumps straight
    /// into that session once the list has loaded.
    private func autoOpenFromEnvironment() {
        guard path.isEmpty,
              let id = ProcessInfo.processInfo.environment["OS1_OPEN_SESSION"],
              let session = viewModel.sessions.first(where: { $0.id == id })
        else { return }
        path.append(session)
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
        return result.sorted {
            switch sortBy {
            case .updated:
                ($0.lastActivityDate ?? .distantPast) > ($1.lastActivityDate ?? .distantPast)
            case .created:
                (Session.parseISO($0.createdAt) ?? .distantPast)
                    > (Session.parseISO($1.createdAt) ?? .distantPast)
            }
        }
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

    private var list: some View {
        List {
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { session in
                        NavigationLink(value: session) {
                            SessionRow(session: session)
                        }
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
                        }
                    }
                }
            }
        }
        .insetGroupedListCompat()
        .searchable(text: $searchText, prompt: "Search sessions")
        .overlay {
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
        .refreshable {
            await viewModel.refresh()
        }
        .navigationDestination(for: Session.self) { session in
            SessionView(session: session)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
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
                    Text("PR open")
                        .foregroundStyle(.green)
                }
                if session.queuedCount ?? 0 > 0 {
                    Text("+\(session.queuedCount!) queued")
                }
                Spacer()
                if let date = session.lastActivityDate {
                    Text(date, format: .relative(presentation: .named))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var statusDot: some View {
        Circle()
            .fill(session.lane.color)
            .frame(width: 8, height: 8)
    }
}
