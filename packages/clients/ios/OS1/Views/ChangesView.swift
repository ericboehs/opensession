import SwiftUI

#if os(iOS)
/// Everything the session's worktree has changed — the native counterpart of
/// the web viewer's Changes tab.
///
/// The workspace sheet has always summarised this (a count, the first handful
/// of files) and then sent people to a browser for the rest. This is the rest:
/// every file, and the diff of any one of them.
///
/// One fetch does it. `GET /api/sessions/:id/diff` answers the file list and
/// the whole worktree's patch together, so a file's diff is a split of what is
/// already in hand rather than a request per row. The split runs once per
/// load, off the main actor, into a path-keyed index — a worktree diff is
/// routinely megabytes, and splitting it inside a row's body would do that
/// work once per file per redraw.
struct ChangesView: View {
    let sessionId: String
    /// Open this file's diff straight away instead of the list — what the
    /// workspace sheet's file rows pass, since they are already the list.
    var focus: String?

    @State private var repos: [OS1API.RepoDiff] = []
    /// repo id → path → that file's section of the repo's patch.
    @State private var patchIndex: [String: [String: FilePatch]] = [:]
    @State private var selectedRepo: String?
    @State private var loading = true
    @State private var loadFailed = false
    /// The file being read, pushed one level deeper.
    @State private var openFile: FilePatch?

    var body: some View {
        Group {
            if let focus {
                focusedFile(focus)
            } else if loading && repos.isEmpty {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && repos.isEmpty {
                failedPlaceholder
            } else if activeDiff?.files.isEmpty ?? true {
                emptyPlaceholder
            } else {
                fileList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle(focus.map(Self.fileName) ?? "Changes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let focus, let file = focusedPatch(focus) {
                    Button {
                        copyToPasteboard(file.patch)
                    } label: {
                        Label("Copy patch", systemImage: "doc.on.doc")
                    }
                } else if focus == nil {
                    Button {
                        Task { await load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
        }
        .navigationDestination(item: $openFile) { file in
            FileDiffView(file: file)
        }
        .task(id: sessionId) { await load() }
    }

    // MARK: - The list

    @ViewBuilder
    private var fileList: some View {
        if let diff = activeDiff {
            List {
                if changedRepos.count > 1 {
                    Section {
                        Picker("Repository", selection: repoSelection) {
                            ForEach(changedRepos, id: \.repo) { repo in
                                Text(RepoTile.label(for: repo.repo)).tag(repo.repo)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                Section {
                    ForEach(diff.files) { file in
                        row(file)
                    }
                } header: {
                    Text(
                        "\(diff.files.count) file"
                        + "\(diff.files.count == 1 ? "" : "s") changed · "
                        + "+\(diff.totalAdditions) −\(diff.totalDeletions)"
                    )
                } footer: {
                    if diff.truncated == true {
                        Text("This diff is too large to send in full. The "
                             + "files above are what fit.")
                    } else if let base = diff.baseRef, !base.isEmpty {
                        Text(verbatim: "Against \(base), including uncommitted work.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            .refreshable { await load() }
        }
    }

    private func row(_ file: OS1API.DiffFile) -> some View {
        let patch = patch(for: file)
        return Button {
            openFile = patch
        } label: {
            HStack(spacing: 10) {
                Image(systemName: DiffFileStyle.icon(file.status))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(DiffFileStyle.color(file.status))
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Self.fileName(file.path))
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let directory = Self.directory(file.path) {
                        Text(directory)
                            .font(.caption2.monospaced())
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                Spacer(minLength: 8)
                Text(counts(file))
                    .font(.caption.monospacedDigit())
                if patch != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A binary file, or one the patch was truncated before reaching:
        // there is nothing to push, and a row that pushes nothing is worse
        // than one that doesn't offer to.
        .disabled(patch == nil)
    }

    private func counts(_ file: OS1API.DiffFile) -> AttributedString {
        if file.binary == true {
            var binary = AttributedString("binary")
            binary.foregroundColor = OS1VisualStyle.textDim
            return binary
        }
        var output = AttributedString()
        if file.additions > 0 {
            var additions = AttributedString("+\(file.additions)")
            additions.foregroundColor = OS1VisualStyle.greenInk
            output.append(additions)
        }
        if file.deletions > 0 {
            if !output.characters.isEmpty { output.append(AttributedString(" ")) }
            var deletions = AttributedString("−\(file.deletions)")
            deletions.foregroundColor = OS1VisualStyle.redInk
            output.append(deletions)
        }
        return output
    }

    /// The single file a workspace-sheet row asked for. Looked up across every
    /// repo in the session: that row doesn't say which repo it came from.
    @ViewBuilder
    private func focusedFile(_ path: String) -> some View {
        if let file = focusedPatch(path) {
            FileDiffView(file: file, chrome: .bare)
        } else if loading {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ListPlaceholder(
                symbol: "doc.text.magnifyingglass",
                title: "No diff for this file",
                message: "It may be binary, or the worktree may have moved on "
                    + "since this list was drawn."
            ) {
                Button("Reload") { Task { await load() } }
                    .buttonStyle(PlaceholderActionStyle())
            }
        }
    }

    // MARK: - Placeholders

    private var emptyPlaceholder: some View {
        ListPlaceholder(
            symbol: "checkmark.circle",
            title: "No changes",
            message: "This worktree matches its base branch."
        ) {
            EmptyView()
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load changes",
            message: "The server didn't answer for this session's diff."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    // MARK: - Data

    /// Only repos with something to show. A session with an attached repo it
    /// never touched should get no picker at all.
    private var changedRepos: [OS1API.RepoDiff] {
        repos.filter { !$0.diff.files.isEmpty }
    }

    private var activeRepo: OS1API.RepoDiff? {
        if let selectedRepo,
           let match = changedRepos.first(where: { $0.repo == selectedRepo }) {
            return match
        }
        return changedRepos.first { $0.primary } ?? changedRepos.first
    }

    private var activeDiff: OS1API.SessionDiff? { activeRepo?.diff }

    private var repoSelection: Binding<String> {
        Binding(
            get: { activeRepo?.repo ?? "" },
            set: { selectedRepo = $0 }
        )
    }

    private func patch(for file: OS1API.DiffFile) -> FilePatch? {
        guard let repo = activeRepo?.repo else { return nil }
        return patchIndex[repo]?[file.path]
    }

    private func focusedPatch(_ path: String) -> FilePatch? {
        for repo in repos {
            if let match = patchIndex[repo.repo]?[path] { return match }
        }
        return nil
    }

    private func load() async {
        loading = true
        loadFailed = false
        let response = try? await OS1API.sessionDiff(sessionId: sessionId)
        guard !Task.isCancelled else { return }
        if let response {
            let loaded = response.repos
            // Splitting a multi-megabyte patch is the one expensive thing
            // here; keep it off the main actor like every other decode.
            let index = await Task.detached(priority: .userInitiated) {
                var index: [String: [String: FilePatch]] = [:]
                for repo in loaded {
                    let patches = PatchSplitter.split(repo.diff.rawPatch ?? "")
                    index[repo.repo] = Dictionary(
                        patches.map { ($0.path, $0) },
                        uniquingKeysWith: { first, _ in first }
                    )
                }
                return index
            }.value
            guard !Task.isCancelled else { return }
            repos = loaded
            patchIndex = index
            loadFailed = false
        } else {
            loadFailed = repos.isEmpty
        }
        loading = false
    }

    static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func directory(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }
}

/// One file's diff, full height.
private struct FileDiffView: View {
    let file: FilePatch
    /// `.bare` is for the case where this IS the panel: the panel already
    /// names the file in the navigation bar, and a second title would blank
    /// the first one.
    var chrome: Chrome = .titled

    enum Chrome { case titled, bare }

    var body: some View {
        ScrollView {
            DiffText(patch: file.patch, maxLines: 2_000)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(OS1VisualStyle.background)
        .modifier(FileDiffChrome(file: file, chrome: chrome))
    }
}

/// The title + copy button, applied only when this view owns the bar.
private struct FileDiffChrome: ViewModifier {
    let file: FilePatch
    let chrome: FileDiffView.Chrome

    func body(content: Content) -> some View {
        if chrome == .titled {
            content
                .navigationTitle(ChangesView.fileName(file.path))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            copyToPasteboard(file.patch)
                        } label: {
                            Label("Copy patch", systemImage: "doc.on.doc")
                        }
                    }
                }
        } else {
            content
        }
    }
}

/// How a changed file reads at a glance — shared so the workspace sheet's
/// summary and the full list can't drift apart.
enum DiffFileStyle {
    static func icon(_ status: String) -> String {
        switch status {
        case "added", "untracked": "plus"
        case "deleted": "minus"
        case "renamed": "arrow.right"
        default: "pencil"
        }
    }

    static func color(_ status: String) -> Color {
        switch status {
        case "added", "untracked": OS1VisualStyle.green
        case "deleted": OS1VisualStyle.red
        case "renamed": OS1VisualStyle.blue
        default: OS1VisualStyle.yellow
        }
    }
}
#endif
