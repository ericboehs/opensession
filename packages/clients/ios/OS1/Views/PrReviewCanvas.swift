import SwiftUI

/// A native committed-diff review surface. Inline notes remain local until the
/// reviewer submits one GitHub review, matching GitHub's pending-review model.
///
/// The code page carries the same two option menus as the web review canvas.
/// They answer different questions, which is why they stay separate: the lens
/// picks WHAT you are reading (the diff, a guided walk through it, a call
/// graph), and the display settings are how the diff is DRAWN (unified or side
/// by side, long lines wrapped or scrolled). The lens resets per visit; the
/// display settings persist, because a reader picks those once.
struct PrReviewCanvas: View {
    let viewModel: SessionViewModel

    /// The lenses the code page can be read through, in menu order.
    enum Lens: String, CaseIterable, Identifiable {
        case all, guide, flow

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: "All changes"
            case .guide: "Review guide"
            case .flow: "Code flow"
            }
        }

        var symbol: String {
            switch self {
            case .all: "doc.plaintext"
            case .guide: "list.bullet.rectangle"
            case .flow: "arrow.triangle.branch"
            }
        }
    }

    /// The lens lives with the review canvas that frames this page: the tab
    /// row above the diff carries the control, the way the web puts it there
    /// rather than in the header.
    @Binding var lens: Lens
    @State private var diff: PrDiff?
    @State private var files: [PrPatchFile] = []
    @State private var viewed = Set<String>()
    /// Which files have been folded away. Open is the resting state, so this
    /// stays empty until a reader puts something aside.
    @State private var folded = Set<String>()
    @State private var viewedPrId: String?
    @State private var loading = true
    @State private var errorText: String?
    @State private var draftComments: [PrInlineComment] = []
    @State private var commentTarget: PrLineTarget?
    @State private var submitting = false
    @State private var reviewing = false
    @State private var guide: PrReviewGuide?
    @State private var guideLoading = false
    @State private var guideError: String?
    @State private var flow: PrCodeFlow?
    @State private var flowLoading = false
    @State private var flowError: String?
    @AppStorage(CodeDisplaySettings.statsKey) private var showFileStats = true

    var body: some View {
        Group {
            if loading && diff == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorText, diff == nil {
                ListPlaceholder(
                    symbol: "exclamationmark.triangle",
                    title: "Couldn't load pull request files",
                    message: errorText
                ) {
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(PlaceholderActionStyle())
                }
            } else if files.isEmpty {
                ListPlaceholder(
                    symbol: "doc.text",
                    title: "No committed changes",
                    message: "This pull request has no textual diff to review."
                ) { EmptyView() }
            } else {
                switch lens {
                case .all: fileList
                case .guide: guideList
                case .flow: flowList
                }
            }
        }
        .toolbar {
            // Only what belongs to the pending review itself. The lens and
            // the display settings ride the tab row, and refreshing is the
            // pull the list already answers.
            ToolbarItem(placement: .topTrailingCompat) {
                if submitting {
                    ProgressView().controlSize(.small)
                } else if !draftComments.isEmpty {
                    Button("Finish review") { reviewing = true }
                }
            }
        }
        .task { await load() }
        .task(id: lens) { await loadLens() }
        .sheet(item: $commentTarget) { target in
            PrInlineCommentSheet(target: target) { text in
                upsertComment(path: target.path, line: target.line, text: text)
            }
        }
        .sheet(isPresented: $reviewing) {
            PrPendingReviewSheet(commentCount: draftComments.count) { event, summary in
                try await viewModel.submitPrReview(
                    event: event,
                    summary: summary,
                    comments: draftComments
                )
                draftComments = []
            }
        }
    }

    /// One file's diff. Built here rather than through a
    /// `navigationDestination(for:)`: this canvas is a PAGE of the review
    /// panel now, not a pushed view of its own, and a value-based link needs
    /// its destination registered on the stack that owns it — which left a
    /// tapped file merely selected. A view-based link needs no registration.
    private func fileView(_ file: PrPatchFile) -> some View {
        PrReviewFileView(
            file: file,
            isViewed: viewed.contains(file.path),
            commentCount: draftComments.filter { $0.path == file.path }.count,
            toggleViewed: { toggleViewed(file.path) },
            comment: { line in commentTarget = PrLineTarget(path: file.path, line: line) }
        )
    }

    // MARK: - All changes

    private var fileList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if showFileStats {
                    HStack {
                        Text("\(files.count) file\(files.count == 1 ? "" : "s") changed")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                        Spacer(minLength: 8)
                        changeCounts
                    }
                    .padding(.horizontal, 4)
                }

                if !draftComments.isEmpty {
                    Text("\(draftComments.count) pending inline comment\(draftComments.count == 1 ? "" : "s") · saved locally until you submit one review")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.yellowInk)
                        .padding(.horizontal, 4)
                }

                ForEach(files) { file in
                    fileCard(file)
                }

                if let skipped = diff?.skippedFiles, skipped > 0 {
                    Text("\(skipped) file\(skipped == 1 ? " was" : "s were") omitted because the patch is too large.")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .padding(.horizontal, 4)
                }
            }
            .padding(16)
        }
        .background(OS1VisualStyle.background)
        .refreshable { await reload() }
    }

    /// One file, open: its name and size on a header, its diff in the card
    /// under it. Open is the resting state, because a page of file names is
    /// not a review; folding is for putting a file you have read out of the
    /// way, and the card is what tells one file's lines from the next one's.
    @ViewBuilder
    private func fileCard(_ file: PrPatchFile) -> some View {
        let isOpen = !folded.contains(file.path)
        let isViewed = viewed.contains(file.path)
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                // Marking a file read is its own target, so folding it away
                // never claims you read it.
                Button {
                    toggleViewed(file.path)
                } label: {
                    Image(systemName: isViewed ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isViewed ? OS1VisualStyle.green : OS1VisualStyle.textDim)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isViewed ? "Mark unviewed" : "Mark viewed")

                Button {
                    if isOpen { folded.insert(file.path) } else { folded.remove(file.path) }
                } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fileName(file.path))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(OS1VisualStyle.text)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let folder = fileFolder(file.path) {
                                Text(folder)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(OS1VisualStyle.textDim)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                        }
                        Spacer(minLength: 8)
                        if showFileStats { fileCounts(file) }
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .rotationEffect(.degrees(isOpen ? 0 : -90))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                NavigationLink { fileView(file) } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(file.path) on its own")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            if isOpen {
                Divider()
                let notes = draftComments.filter { $0.path == file.path }.count
                if notes > 0 {
                    HStack {
                        Text("\(notes) pending comment\(notes == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.yellowInk)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
                PrFileDiffBody(
                    file: file,
                    comment: { line in
                        commentTarget = PrLineTarget(path: file.path, line: line)
                    }
                )
                .padding(.vertical, 8)
            }
        }
        .background(OS1VisualStyle.raised)
        // Clipped, not just filled: the diff's own washes run the full width
        // of the line, and unclipped they square off the card's corners.
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        // A read file steps back rather than disappearing: it is still part of
        // the change, it just is not what you are looking for any more.
        .opacity(isViewed && !isOpen ? 0.6 : 1)
    }

    /// The file's own name carries the weight; the folder above it is context.
    private func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func fileFolder(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }

    /// How much of the change is this file's, counted from its own lines.
    private func fileCounts(_ file: PrPatchFile) -> some View {
        let added = file.lines.filter { $0.kind == .addition }.count
        let removed = file.lines.filter { $0.kind == .deletion }.count
        return HStack(spacing: 5) {
            Text("+\(added)").foregroundStyle(OS1VisualStyle.greenInk)
            Text("−\(removed)").foregroundStyle(OS1VisualStyle.redInk)
        }
        .font(.caption2.monospacedDigit())
    }

    /// How big the change is, beside the count of files it touches — the same
    /// pair the web puts in the code page's chrome row.
    @ViewBuilder
    private var changeCounts: some View {
        if let pr = viewModel.prDetails {
            HStack(spacing: 5) {
                Text("+\(pr.additions ?? 0)").foregroundStyle(OS1VisualStyle.greenInk)
                Text("−\(pr.deletions ?? 0)").foregroundStyle(OS1VisualStyle.redInk)
            }
            .font(.caption.monospacedDigit())
        }
    }

    private func fileRow(_ file: PrPatchFile) -> some View {
        HStack(spacing: 10) {
            Image(systemName: viewed.contains(file.path) ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(viewed.contains(file.path) ? .green : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.path).font(.subheadline.monospaced())
                    .lineLimit(1).truncationMode(.middle)
                let notes = draftComments.filter { $0.path == file.path }.count
                if notes > 0 {
                    Text("\(notes) pending comment\(notes == 1 ? "" : "s")")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    // MARK: - Review guide

    @ViewBuilder
    private var guideList: some View {
        if guideLoading && guide == nil {
            ProgressView("Reading the change")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let guide, !guide.sections.isEmpty {
            List {
                ForEach(guide.sections) { section in
                    Section {
                        Text(section.explanation)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 2)
                        ForEach(section.files, id: \.self) { path in
                            guideFileRow(path)
                        }
                    } header: {
                        Text(section.title)
                    }
                }
            }
            .insetGroupedListCompat()
            .refreshable { await reload() }
        } else {
            ListPlaceholder(
                symbol: "list.bullet.rectangle",
                title: "No review guide yet",
                message: guideError
                    ?? "A guide is written once per commit. Try again in a moment, or read all changes."
            ) {
                Button("All changes") { lens = .all }
                    .buttonStyle(PlaceholderActionStyle())
            }
        }
    }

    @ViewBuilder
    private func guideFileRow(_ path: String) -> some View {
        if let file = files.first(where: { $0.path == path }) {
            NavigationLink { fileView(file) } label: { fileRow(file) }
        } else {
            HStack(spacing: 10) {
                Image(systemName: "doc").foregroundStyle(.secondary)
                Text(path).font(.subheadline.monospaced())
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Code flow

    @ViewBuilder
    private var flowList: some View {
        if flowLoading && flow == nil {
            ProgressView("Tracing the change")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let flow, !flow.trees.isEmpty {
            List {
                ForEach(flow.trees) { tree in
                    Section {
                        ForEach(PrCodeFlowRow.rows(of: tree.tree)) { row in
                            flowRow(row)
                        }
                    } header: {
                        Text(tree.entry).font(.caption.monospaced())
                    }
                }
                if flow.truncated == true {
                    Section {
                        Text("The graph was cut short because the change is large.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .insetGroupedListCompat()
            .refreshable { await reload() }
        } else {
            ListPlaceholder(
                symbol: "arrow.triangle.branch",
                title: "No code flow",
                message: flowError
                    ?? "This change has no traced call graph. Read it as a diff instead."
            ) {
                Button("All changes") { lens = .all }
                    .buttonStyle(PlaceholderActionStyle())
            }
        }
    }

    private func flowRow(_ row: PrCodeFlowRow) -> some View {
        HStack(spacing: 8) {
            Color.clear.frame(width: CGFloat(row.depth) * 12, height: 1)
            Text(row.node.mark)
                .font(.caption.monospaced().bold())
                .foregroundStyle(flowTone(row.node.status))
                .frame(width: 10)
            Text(row.node.label)
                .font(.caption.monospaced())
                .foregroundStyle(flowTone(row.node.status))
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 6)
            if let path = row.node.file, let file = files.first(where: { $0.path == path }) {
                NavigationLink {
                    fileView(file)
                } label: {
                    Text(shortPath(path))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.head)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: 140, alignment: .trailing)
            }
        }
    }

    private func flowTone(_ status: String) -> Color {
        switch status {
        case "added": OS1VisualStyle.greenInk
        case "removed": OS1VisualStyle.redInk
        case "modified": .orange
        default: .secondary
        }
    }

    private func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.count > 2 ? parts.suffix(2).joined(separator: "/") : path
    }

    // MARK: - Loading

    private func load() async {
        loading = true
        errorText = nil
        do {
            async let loadedDiff = OS1API.prDiff(sessionId: viewModel.session.id)
            guard let patch = try await loadedDiff else {
                diff = nil
                files = []
                loading = false
                return
            }
            let parsed = await Task.detached(priority: .userInitiated) {
                PrPatchParser.files(in: patch.patch)
            }.value
            diff = patch
            files = parsed
            if let fileState = try? await OS1API.prViewedFiles(
                repo: viewModel.session.repo,
                number: patch.number
            ) {
                viewedPrId = fileState.prId
                viewed = Set(fileState.viewed)
            }
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }

    /// Reload the diff and whatever lens is on screen, so pull-to-refresh means
    /// the same thing on all three pages.
    private func reload() async {
        await load()
        guide = lens == .guide ? nil : guide
        flow = lens == .flow ? nil : flow
        await loadLens()
    }

    /// Each lens loads on first use, not with the canvas: the guide is a
    /// per-commit model call and the flow parses source, and a reader who only
    /// wants the diff should pay for neither.
    private func loadLens() async {
        switch lens {
        case .all:
            return
        case .guide:
            guard guide == nil, !guideLoading else { return }
            guideLoading = true
            guideError = nil
            do {
                guide = try await OS1API.prReviewGuide(sessionId: viewModel.session.id)
            } catch {
                guideError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            guideLoading = false
        case .flow:
            guard flow == nil, !flowLoading else { return }
            flowLoading = true
            flowError = nil
            do {
                flow = try await OS1API.prCodeFlow(sessionId: viewModel.session.id)
            } catch {
                flowError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            flowLoading = false
        }
    }

    private func toggleViewed(_ path: String) {
        guard let viewedPrId else { return }
        let target = !viewed.contains(path)
        if target { viewed.insert(path) } else { viewed.remove(path) }
        Task {
            do {
                try await OS1API.setPrFileViewed(prId: viewedPrId, path: path, viewed: target)
            } catch {
                if target { viewed.remove(path) } else { viewed.insert(path) }
                errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func upsertComment(path: String, line: Int, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let comment = PrInlineComment(path: path, line: line, text: trimmed)
        draftComments.removeAll { $0.id == comment.id }
        draftComments.append(comment)
    }
}

/// One flattened node of a code-flow tree. The web draws the tree fully
/// expanded, so this flattens rather than collapsing behind disclosure rows.
struct PrCodeFlowRow: Identifiable {
    let id: String
    let node: PrCodeFlowNode
    let depth: Int

    static func rows(of root: PrCodeFlowNode) -> [PrCodeFlowRow] {
        var rows: [PrCodeFlowRow] = []
        func walk(_ node: PrCodeFlowNode, depth: Int, path: String) {
            let id = "\(path)/\(node.key):\(node.status)"
            rows.append(PrCodeFlowRow(id: id, node: node, depth: depth))
            for (index, child) in node.children.enumerated() {
                walk(child, depth: depth + 1, path: "\(id).\(index)")
            }
        }
        walk(root, depth: 0, path: "")
        return rows
    }
}

/// Picks what the review canvas shows. Rendering preferences have their own
/// shared control beside this one because they also apply to worktree Changes.
struct PrViewOptionsMenu: View {
    @Binding var lens: PrReviewCanvas.Lens

    var body: some View {
        Menu {
            Picker("View", selection: $lens) {
                ForEach(PrReviewCanvas.Lens.allCases) { option in
                    Label(option.label, systemImage: option.symbol).tag(option)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label("View options", systemImage: "slider.horizontal.3")
        }
    }

}

/// A file's diff. The same body whether it is folded open inside the list or
/// filling a pushed screen, so the two can never drift apart.
///
/// Wrapped lines have nowhere to scroll sideways, so wrapping drops the
/// horizontal axis entirely rather than leaving a scroll view that never
/// moves.
///
/// Inline, lines ALWAYS wrap, whatever the reader picked. A card in a stack
/// of files has no room for a second axis, and a horizontal scroll view there
/// swallows the swipe that moves between the canvas's pages — you could swipe
/// into Files and not back out. The full-screen file keeps both axes and
/// honours the setting, which is what it is for.
struct PrFileDiffBody: View {
    let file: PrPatchFile
    /// Nil on worktree Changes, where there is no GitHub review thread to
    /// anchor a comment to.
    let comment: ((Int) -> Void)?
    /// Inline, the enclosing list scrolls vertically and this must not.
    var inline = true

    @AppStorage(CodeDisplaySettings.styleKey) private var styleRaw = "unified"
    @AppStorage(CodeDisplaySettings.wrapKey) private var wrapLines = false
    @AppStorage(CodeDisplaySettings.highlightKey) private var highlightEdits = true
    @AppStorage(CodeDisplaySettings.themeKey) private var themeRaw = "system"
    @State private var viewportHeight: CGFloat = 0

    private var style: PrDiffStyle {
        PrDiffStyle(rawValue: styleRaw) ?? CodeDisplaySettings.defaults.style
    }

    var body: some View {
        Group {
            if inline {
                lines
            } else if wrapLines {
                ScrollView(.vertical) { lines.padding(.vertical, 8) }
            } else {
                // A two-axis scroll view centres content smaller than itself, which
                // parks a short file in the middle of the screen. The min height
                // pins it to the top instead.
                ScrollView([.horizontal, .vertical]) {
                    lines
                        .frame(minWidth: style == .split ? 1040 : 680, alignment: .leading)
                        .frame(minHeight: viewportHeight, alignment: .top)
                        .padding(.vertical, 8)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
            }
        }
        .background(
            themeRaw == CodeDisplaySettings.Theme.system.rawValue
                ? Color.clear
                : OS1VisualStyle.background
        )
        .codeDisplayTheme()
    }

    @ViewBuilder
    private var lines: some View {
        let wraps = inline || wrapLines
        LazyVStack(alignment: .leading, spacing: 0) {
            if style == .split {
                ForEach(PrPatchParser.rows(file.lines)) { row in
                    PrReviewSplitRowView(
                        row: row,
                        wraps: wraps,
                        highlightsEdits: highlightEdits,
                        comment: comment
                    )
                }
            } else {
                ForEach(file.lines) { line in
                    PrReviewLineView(
                        line: line,
                        wraps: wraps,
                        highlightsEdits: highlightEdits,
                        comment: comment
                    )
                }
            }
        }
    }
}

private struct PrReviewFileView: View {
    let file: PrPatchFile
    let isViewed: Bool
    let commentCount: Int
    let toggleViewed: () -> Void
    let comment: (Int) -> Void

    var body: some View {
        PrFileDiffBody(file: file, comment: comment, inline: false)
            .background(OS1VisualStyle.background)
            .navigationTitle(file.path.split(separator: "/").last.map(String.init) ?? file.path)
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topTrailingCompat) {
                    CodeDisplaySettingsButton()
                }
                ToolbarItem(placement: .topTrailingCompat) {
                    Button(action: toggleViewed) {
                        Label(isViewed ? "Mark unviewed" : "Mark viewed", systemImage: isViewed ? "eye.slash" : "eye")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if commentCount > 0 {
                    Text("\(commentCount) pending inline comment\(commentCount == 1 ? "" : "s")")
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.bottom, 8)
                }
            }
    }

}

private struct PrReviewLineView: View {
    let line: PrPatchLine
    var wraps = false
    var highlightsEdits = true
    let comment: ((Int) -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldLine.map(String.init) ?? "")
                .frame(width: 44, alignment: .trailing)
            Text(line.newLine.map(String.init) ?? "")
                .frame(width: 44, alignment: .trailing)
            // Wrapped: the line takes the width it is given and grows down.
            // Unwrapped: it takes its own full width and the page scrolls
            // sideways to it, which is what "wrap long lines" turns off.
            Text(line.text.isEmpty ? " " : line.text)
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: !wraps, vertical: true)
                .frame(maxWidth: wraps ? .infinity : nil, alignment: .leading)
                .padding(.leading, 10)
            if !wraps { Spacer(minLength: 0) }
            if let anchor = line.commentLine, let comment {
                Button { comment(anchor) } label: {
                    Image(systemName: "plus.bubble")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 8)
                .accessibilityLabel("Add inline comment on line \(anchor)")
            } else if comment != nil {
                Color.clear.frame(width: 36)
            }
        }
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(PrDiffInk.foreground(line.kind))
        .background(highlightsEdits ? PrDiffInk.background(line.kind) : .clear)
        .textSelection(.enabled)
    }
}

/// One row of the side-by-side diff: the old side and the new side of the same
/// change, with the comment anchor on the right where GitHub accepts it.
private struct PrReviewSplitRowView: View {
    let row: PrPatchRow
    var wraps = false
    var highlightsEdits = true
    let comment: ((Int) -> Void)?

    var body: some View {
        if let header = row.header {
            Text(header.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(PrDiffInk.foreground(.metadata))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 10)
                .background(PrDiffInk.background(.metadata))
        } else {
            HStack(spacing: 0) {
                side(row.left, number: row.left?.oldLine)
                Rectangle()
                    .fill(OS1VisualStyle.border)
                    .frame(width: 1)
                side(row.right, number: row.right?.newLine, anchor: row.right?.commentLine)
            }
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
        }
    }

    private func side(_ line: PrPatchLine?, number: Int?, anchor: Int? = nil) -> some View {
        HStack(spacing: 0) {
            Text(number.map(String.init) ?? "")
                .frame(width: 40, alignment: .trailing)
            // Wrapped columns share the available width. Unwrapped columns
            // keep a readable minimum but grow to the line's intrinsic width,
            // so the enclosing horizontal scroll view never clips long lines.
            Text((line?.text).flatMap { $0.isEmpty ? " " : $0 } ?? " ")
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: !wraps, vertical: true)
                .frame(maxWidth: wraps ? .infinity : nil, alignment: .leading)
                .padding(.leading, 8)
            if let anchor, let comment {
                Button { comment(anchor) } label: {
                    Image(systemName: "plus.bubble")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 6)
                .accessibilityLabel("Add inline comment on line \(anchor)")
            } else if comment != nil {
                Color.clear.frame(width: 26)
            }
        }
        .frame(
            minWidth: wraps ? 0 : 520,
            maxWidth: wraps ? .infinity : nil,
            alignment: .leading
        )
        .foregroundStyle(PrDiffInk.foreground(line?.kind ?? .context))
        .background(
            highlightsEdits ? PrDiffInk.background(line?.kind ?? .context) : .clear
        )
    }
}

/// One definition of diff ink, shared by the unified and split renderers so
/// the two can't drift.
private enum PrDiffInk {
    static func foreground(_ kind: PrPatchLine.Kind) -> Color {
        switch kind {
        case .addition: OS1VisualStyle.greenInk
        case .deletion: OS1VisualStyle.redInk
        case .metadata: OS1VisualStyle.blueInk
        case .context: OS1VisualStyle.codeWellText
        }
    }

    static func background(_ kind: PrPatchLine.Kind) -> Color {
        switch kind {
        case .addition: OS1VisualStyle.green.opacity(0.10)
        case .deletion: OS1VisualStyle.red.opacity(0.10)
        default: .clear
        }
    }
}

private struct PrLineTarget: Identifiable {
    let path: String
    let line: Int
    var id: String { "\(path):\(line)" }
}

private struct PrInlineCommentSheet: View {
    let target: PrLineTarget
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("\(target.path):\(target.line)").font(.caption.monospaced())
                }
                Section("Comment") {
                    TextEditor(text: $text).frame(minHeight: 140).focused($focused)
                }
            }
            .navigationTitle("Inline comment")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topTrailingCompat) {
                    Button("Add") { save(text); dismiss() }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .task { focused = true }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 360)
        #endif
    }
}

private struct PrPendingReviewSheet: View {
    let commentCount: Int
    let submit: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var event = "COMMENT"
    @State private var summary = ""
    @State private var sending = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("\(commentCount) inline comment\(commentCount == 1 ? "" : "s") will be submitted together.")
                }
                Section {
                    Picker("Review", selection: $event) {
                        Text("Comment").tag("COMMENT")
                        Text("Approve").tag("APPROVE")
                        Text("Request changes").tag("REQUEST_CHANGES")
                    }.pickerStyle(.segmented).labelsHidden()
                }
                Section("Summary") { TextEditor(text: $summary).frame(minHeight: 110) }
                if let errorText { Section { Text(errorText).foregroundStyle(.red) } }
            }
            .navigationTitle("Submit review")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topTrailingCompat) {
                    if sending { ProgressView().controlSize(.small) } else {
                        Button("Submit") { send() }
                    }
                }
            }
            .disabled(sending)
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 400)
        #endif
    }

    private func send() {
        sending = true
        errorText = nil
        Task {
            do {
                try await submit(event, summary)
                dismiss()
            } catch {
                errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            sending = false
        }
    }
}
