import SwiftUI
#if os(iOS)

/// What the team shipped.
///
/// One row per merged pull request and per commit on a repo that ships
/// without them, in one list, newest first. The page answers "what shipped"
/// rather than "what merged", which is why both kinds sit together and sort
/// together instead of living in two lists.
///
/// The layout is the web page's at phone width (`components/Feed.tsx` with
/// `PR_FEED_ROW`), because the two are the same screen read on the same
/// device: a strip of faces to narrow it by person, day headings that carry
/// their own count, and one-line rows whose leading column is WHO shipped it.
/// The phone drew something else for a while — a kind glyph, a two-line row,
/// a meta line restating the repo and the time — which is why the same feed
/// looked like a different product depending on which app you opened.
///
/// Picking a person here narrows this page only. On the web the same pick also
/// turns the sidebar to them; here the sidebar has a strip of its own
/// (`SidebarPresenceStrip`), and this screen is pushed OVER that list rather
/// than beside it, so reaching back to change it would take a list you cannot
/// see.
struct FeedView: View {
    /// Opens the session behind a row. Handed up, because this screen rides
    /// the sessions list's navigation stack.
    let onOpenSession: (String) -> Void

    @Environment(\.openURL) private var openURL

    @State private var rows: [FeedRow] = []
    @State private var repo = FeedView.allRepos
    /// Whose work the page is showing, in the same person keys the sidebar
    /// lens uses. Local to this screen, and reset by "Everyone".
    @State private var person = SidebarPersonLens.everyone
    @State private var days = FeedView.daySteps[0]
    @State private var hasMore = false
    @State private var loading = true
    @State private var loadFailed = false
    @State private var loadGeneration = 0

    /// How far back the feed reaches, in days, and the steps "Show more"
    /// walks. A window rather than a row count: on a repo that ships a hundred
    /// times a day a flat cap is spent before the first day ends, so the list
    /// reads as "the feed only shows today" and no amount of scrolling reaches
    /// yesterday.
    private static let daySteps = [3, 7, 14, 45]
    private static let allRepos = "all"

    /// A ceiling on rendered rows, so a very wide window cannot stall the
    /// screen. It sits far above a busy fortnight; the window is what normally
    /// binds.
    private static let renderCeiling = 600

    var body: some View {
        Group {
            if loading && rows.isEmpty {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && rows.isEmpty {
                failedPlaceholder
            } else if rows.isEmpty {
                emptyPlaceholder
            } else {
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle("Feed")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if repos.count > 1 {
                ToolbarItem(placement: .topBarTrailing) { repoMenu }
            }
        }
        .task { await load() }
    }

    private var repoMenu: some View {
        Menu {
            Picker("Project", selection: $repo) {
                Text("All projects").tag(Self.allRepos)
                ForEach(repos, id: \.self) { name in
                    Text(RepoTile.label(for: name)).tag(name)
                }
            }
        } label: {
            Image(systemName: repo == Self.allRepos
                ? "line.3.horizontal.decrease.circle"
                : "line.3.horizontal.decrease.circle.fill")
                .foregroundStyle(repo == Self.allRepos
                    ? OS1VisualStyle.text
                    : OS1VisualStyle.accentInk)
        }
        .accessibilityLabel(
            repo == Self.allRepos
                ? "Filter by project"
                : "Filtered to \(RepoTile.label(for: repo))"
        )
    }

    private var list: some View {
        List {
            // The web's chip row, in the app's own strip. It leads the page
            // there and it leads it here, because who shipped something is
            // how you narrow a feed.
            Section {
                SidebarPresenceStrip(
                    person: $person,
                    currentUser: ServerConfig.shared.userName
                )
                .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 6, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }

            ForEach(groups, id: \.title) { group in
                Section {
                    ForEach(group.rows) { row in
                        FeedRowView(row: row, onOpen: openAction(for: row))
                            .listRowInsets(EdgeInsets(
                                top: 0, leading: 16, bottom: 0, trailing: 16
                            ))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                } header: {
                    // The day, and how much landed in it. The count is what
                    // the web's heading carries too: a day is worth reading
                    // past when you can see how much is under it.
                    HStack(spacing: 6) {
                        Text(group.title)
                        Text(verbatim: "\(group.rows.count)")
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .textCase(nil)
                    .listRowInsets(EdgeInsets(
                        top: 10, leading: 16, bottom: 4, trailing: 16
                    ))
                }
            }

            if !groups.isEmpty, hasMore,
               let next = Self.daySteps.first(where: { $0 > days }) {
                Section {
                    Button {
                        Task { await load(days: next) }
                    } label: {
                        HStack {
                            Spacer()
                            Text("Show the last \(next) days")
                                .font(.callout.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.accentInk)
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(loading)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
            }

            if groups.isEmpty, !loading { narrowedToNothing }
        }
        .listStyle(.plain)
        // Rows carry their own height in their padding, like the sessions
        // list: the 44pt floor only inflated the day headings.
        .environment(\.defaultMinListRowHeight, 8)
        .listSectionSpacing(2)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .refreshable { await load(days: days) }
    }

    /// A pick with nothing under it is an answer, so the strip and the filter
    /// stay put and the sentence names what emptied the list. Both controls
    /// are on screen, so "there is nothing" is the one thing it must not say.
    private var narrowedToNothing: some View {
        Section {
            VStack(spacing: 4) {
                Text("Nothing shipped yet")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                Text(narrowedMessage)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
    }

    private var narrowedMessage: String {
        let who = personLabel
        let where_ = repo == Self.allRepos ? nil : RepoTile.label(for: repo)
        switch (who, where_) {
        case let (who?, where_?):
            return "\(who) hasn't shipped anything in \(where_) recently."
        case let (who?, nil):
            return "\(who) hasn't shipped anything recently."
        case let (nil, where_?):
            return "Nothing has shipped in \(where_) recently."
        default:
            return "Merged pull requests and commits show up here."
        }
    }

    /// The picked person as a name, or nil while the page is on everyone.
    private var personLabel: String? {
        switch person {
        case SidebarPersonLens.everyone:
            return nil
        case SidebarPersonLens.me:
            let user = ServerConfig.shared.userName.trimmingCharacters(in: .whitespaces)
            return user.isEmpty ? "You" : user
        default:
            return TeamDirectory.shared.names.first {
                SidebarPersonLens.nameMatches($0, key: person)
            } ?? person
        }
    }

    private var emptyPlaceholder: some View {
        ListPlaceholder(
            symbol: "shippingbox",
            title: "Nothing shipped yet",
            message: "Merged pull requests and commits collect here as the team lands work."
        ) {
            EmptyView()
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load the feed",
            message: "The server didn't answer for recent work."
        ) {
            Button("Try again") { Task { await load(days: days) } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    /// Every project with something in the window, so the filter never offers
    /// a project the current feed cannot show.
    private var repos: [String] {
        Array(Set(rows.map(\.repo))).sorted()
    }

    private var visibleRows: [FeedRow] {
        let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
        let recent = rows.filter { ($0.shippedAt ?? .distantPast) >= cutoff }
        let scoped = recent.filter { inRepo($0) && inScope($0) }
        return Array(scoped.prefix(Self.renderCeiling))
    }

    private func inRepo(_ row: FeedRow) -> Bool {
        repo == Self.allRepos || row.repo == repo
    }

    /// The person scope. A row's owner is a teammate's name or an
    /// automation's, and the loose compare is the app's usual one — the same
    /// person reaches us as "Kent", "Kent de Bruin" or "kentdebruin"
    /// depending on which surface recorded them.
    private func inScope(_ row: FeedRow) -> Bool {
        switch person {
        case SidebarPersonLens.everyone:
            return true
        case SidebarPersonLens.me:
            guard let owner = row.owner else { return false }
            return SidebarPersonLens.nameMatches(owner, key: ServerConfig.shared.userName)
        default:
            guard let owner = row.owner else { return false }
            return SidebarPersonLens.nameMatches(owner, key: person)
        }
    }

    private struct DayGroup {
        let title: String
        let rows: [FeedRow]
    }

    /// Banded by day, in the order the rows already carry. Built once per
    /// render pass rather than per row, and every date it needs was resolved
    /// when the rows were built.
    private var groups: [DayGroup] {
        var groups: [DayGroup] = []
        var currentTitle: String?
        var current: [FeedRow] = []
        for row in visibleRows {
            let title = Self.dayTitle(row.shippedAt)
            if title != currentTitle {
                if let currentTitle, !current.isEmpty {
                    groups.append(DayGroup(title: currentTitle, rows: current))
                }
                currentTitle = title
                current = []
            }
            current.append(row)
        }
        if let currentTitle, !current.isEmpty {
            groups.append(DayGroup(title: currentTitle, rows: current))
        }
        return groups
    }

    private static func dayTitle(_ date: Date?) -> String {
        guard let date else { return "Earlier" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    /// The session if there is one, the pull request or commit on the host if
    /// there is not. A shipped commit's session is usually archived, which is
    /// exactly the case the row keeps an id for. A row with neither stays
    /// readable without pretending a tap can take it anywhere.
    private func openAction(for row: FeedRow) -> (() -> Void)? {
        if let sessionId = row.sessionId {
            return { onOpenSession(sessionId) }
        }
        if let url = row.url.flatMap(URL.init(string:)) {
            return { openURL(url) }
        }
        return nil
    }

    private func load(days next: Int? = nil) async {
        let window = next ?? days
        loadGeneration &+= 1
        let generation = loadGeneration
        loading = true
        defer {
            if generation == loadGeneration { loading = false }
        }
        // The roster decides which owners are people, so the faces resolve on
        // the first frame rather than after a second pass.
        async let roster: Void = TeamDirectory.shared.ensureLoaded()
        // Both at once: they are independent reads, and the feed is the sum
        // of them rather than one after the other.
        async let prsTask = try? OS1API.recentPrs()
        async let commitsTask = try? OS1API.recentCommits(days: window)
        let (prs, page) = await (prsTask, commitsTask)
        await roster
        guard generation == loadGeneration, !Task.isCancelled else { return }
        // Both halves failing is a failure; one is a thinner feed, which is
        // still the honest answer for an instance where only one of them
        // exists at all.
        if prs == nil && page == nil {
            if rows.isEmpty { loadFailed = true }
            return
        }
        // The PR cache can hold thousands of rows. Parse and sort them away
        // from the main actor so opening Feed never stalls the navigation
        // transition while ICU resolves their timestamps.
        let built = await Task.detached(priority: .userInitiated) {
            FeedRows.build(prs: prs ?? [], commits: page?.commits ?? [])
        }.value
        guard generation == loadGeneration, !Task.isCancelled else { return }
        let servedDays = page?.days ?? window
        let cutoff = Date().addingTimeInterval(-Double(servedDays) * 86_400)
        rows = built
        days = servedDays
        hasMore = (page?.hasMore ?? false)
            || built.contains { ($0.shippedAt ?? .distantPast) < cutoff }
        loadFailed = false
    }
}

/// One shipped thing, on one line.
///
/// The web's phone row exactly: a 24pt owner mark, then the repo's tile in
/// front of the title with its ref after it, then how long ago on the right.
/// The diff counts are the one column the web drops at this width and so does
/// this — a row that has to truncate its title to print "+412 −38" has traded
/// the thing you read the feed for.
private struct FeedRowView: View {
    let row: FeedRow
    let onOpen: (() -> Void)?

    @ViewBuilder
    var body: some View {
        if let onOpen {
            Button(action: onOpen) { content }
                .buttonStyle(.plain)
                .accessibilityLabel(accessibilityLabel)
        } else {
            content.accessibilityLabel(accessibilityLabel)
        }
    }

    private var content: some View {
        HStack(spacing: 10) {
            ownerMark
            // One line. The repo rides in front of the title as its mark
            // alone: its name on a second line spent a whole row restating
            // what the picture already says, and made the feed twice as tall
            // as it needs to be. The name is in the repo filter above.
            RepoTile(name: row.repo, size: 16)
            Text(row.title)
                .font(.callout.weight(.medium))
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !row.ref.isEmpty {
                Text(verbatim: row.ref)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .fixedSize(horizontal: true, vertical: false)
            }
            Text(verbatim: age)
                .font(.caption.monospacedDigit())
                .foregroundStyle(OS1VisualStyle.textFaint)
                .fixedSize(horizontal: true, vertical: false)
        }
        // The 44pt row the sessions list and the settings rows already stand
        // at, now that the row is one line rather than two.
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    /// Who shipped it, in the same 24pt slot whoever they are. A teammate
    /// wears their face; an automation wears a glyph in the avatar's own
    /// shape, so the column reads as one column of owners rather than faces
    /// and something else. A row that recorded no author at all falls back to
    /// the kind it was, which is the only thing left that says anything.
    @ViewBuilder
    private var ownerMark: some View {
        if let owner = row.owner, !owner.isEmpty {
            if isPerson(owner) {
                UserAvatar(person: owner, size: 24)
            } else {
                WebIcon(kind: .robot, size: 14, color: OS1VisualStyle.textDim)
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(OS1VisualStyle.hover))
                    .accessibilityLabel(owner)
            }
        } else {
            Image(systemName: row.kind == .pullRequest
                ? "arrow.trianglehead.pull"
                : "point.3.connected.trianglepath.dotted")
                .font(.system(size: 13))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(width: 24, height: 24)
        }
    }

    /// The roster decides whether an owner is a teammate. An automation owns
    /// its own sessions and carries its own name, so a name nobody on the
    /// roster answers to is drawn as a machine rather than given a face made
    /// of its initial.
    private func isPerson(_ owner: String) -> Bool {
        TeamDirectory.shared.names.contains {
            SidebarPersonLens.nameMatches($0, key: owner)
        }
    }

    /// How long ago, in the sessions list's own compact form, so one glance
    /// down the right edge reads the same on both screens.
    private var age: String {
        guard let shippedAt = row.shippedAt else { return "" }
        return SessionRow.compactAgo(Date().timeIntervalSince(shippedAt))
    }

    private var accessibilityLabel: String {
        let kind = row.kind == .pullRequest ? "Pull request" : "Commit"
        var label = "\(kind) \(row.ref) in \(RepoTile.label(for: row.repo)): \(row.title)"
        if let owner = row.owner, !owner.isEmpty { label += ", by \(owner)" }
        return label
    }
}
#endif
