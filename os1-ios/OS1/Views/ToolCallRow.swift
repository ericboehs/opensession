import SwiftUI

/// One tool call: a single summary line that expands into a rendering shaped
/// for that particular tool — a diff for an edit, a command for a shell call,
/// file content for a write. Raw JSON is the fallback, never the default.
struct ToolCallRow: View {
    let item: ToolCallItem
    let sessionId: String
    var worktreeDir: String?
    let state: TurnFoldState

    /// Built once per expansion and cached: parsing tool input to synthesize
    /// a diff must never happen inside `body`.
    @State private var detail: ToolDetail?
    /// The worker sheet opened from a Task row.
    @State private var openWorker: WorkerLink?
    /// Installed by the iOS session screen; absent everywhere else, which is
    /// what keeps the asset chip from appearing where nothing can open it.
    @Environment(\.openPanel) private var openPanel

    private var presentation: ToolPresentation { item.presentation }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                withAnimation(.snappy(duration: 0.2, extraBounce: 0)) {
                    state.toggle()
                }
            } label: {
                summaryRow
            }
            .buttonStyle(.plain)

            if state.expanded {
                detailBody
                    .padding(.leading, 22)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: detailKey) {
            guard state.expanded, detail == nil else { return }
            detail = ToolDetail.make(item: item)
        }
        .onChange(of: item.result?.id) { _, _ in detail = nil }
        .sheet(item: $openWorker) { link in
            SubagentView(
                sessionId: sessionId,
                agentId: link.id,
                worktreeDir: worktreeDir
            )
        }
    }

    /// Identifies the sheet's subject; `sheet(item:)` needs Identifiable.
    private struct WorkerLink: Identifiable { let id: String }

    /// The row's drill-in: a worker's transcript, a written file. One pill for
    /// both, so a row that leads somewhere always says so the same way.
    private struct RowChip: View {
        let title: String
        let action: () -> Void

        var body: some View {
            Button(action: action) {
                HStack(spacing: 3) {
                    Text(title)
                    Image(systemName: "arrow.up.right")
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .overlay {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var detailKey: String {
        "\(item.id)|\(state.expanded)|\(item.result?.id ?? "")"
    }

    // MARK: - Summary line

    private var summaryRow: some View {
        HStack(spacing: 7) {
            // The glyph doubles as the disclosure control: it turns into a
            // chevron when open, which costs no width on a phone.
            Image(systemName: state.expanded ? "chevron.down" : presentation.family.symbol)
                .font(.system(size: 11))
                .foregroundStyle(
                    item.isError ? OS1VisualStyle.red : OS1VisualStyle.textFaint
                )
                .frame(width: 15)

            if let server = presentation.mcpServer {
                Text(server)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(
                        OS1VisualStyle.panel,
                        in: RoundedRectangle(cornerRadius: 4, style: .continuous)
                    )
                    .fixedSize()
            }

            Text(presentation.name)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                .fixedSize()

            if !presentation.summary.isEmpty {
                summaryText
            }

            Spacer(minLength: 4)

            // A Task call is otherwise a dead end: the row says a worker was
            // spawned and nothing says what it did.
            if let agentId = item.subagentId {
                RowChip(title: item.isPending ? "Watch" : "Open") {
                    openWorker = WorkerLink(id: agentId)
                }
                .accessibilityLabel("Open this sub-agent's transcript")
            }

            // Same dead end for a written asset: the row names a file the
            // conversation itself can't show. The chip opens the file itself,
            // one level deeper — back is the chevron, or the edge swipe.
            if let assetPath = item.assetPath, openPanel.isAvailable {
                RowChip(title: "Open") {
                    openPanel(.asset(sessionId: sessionId, path: assetPath))
                }
                .accessibilityLabel("Open this file")
            }

            if let stats = presentation.lineStats {
                LineStatsView(stats: stats)
            }

            statusGlyph
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(presentation.displayName). \(presentation.summary)")
    }

    /// A path's directory dims so the filename — the part that identifies the
    /// call — survives truncation at the head.
    @ViewBuilder
    private var summaryText: some View {
        let value = presentation.summary
        Group {
            if presentation.summaryIsPath, let slash = value.lastIndex(of: "/") {
                Text(value[value.startIndex...slash])
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    + Text(value[value.index(after: slash)...])
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else {
                Text(value)
                    .foregroundStyle(
                        item.isError ? OS1VisualStyle.red : OS1VisualStyle.textFaint
                    )
            }
        }
        .font(.system(.caption, design: .monospaced))
        .lineLimit(1)
        .truncationMode(presentation.summaryIsPath ? .head : .tail)
    }

    @ViewBuilder
    private var statusGlyph: some View {
        if item.isPending {
            ProgressView()
                .controlSize(.mini)
        } else if item.isError {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.red)
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detailBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let detail {
                if !detail.inputText.isEmpty {
                    switch detail.inputKind {
                    case .diff:
                        ToolCodeBox(label: detail.inputLabel) {
                            DiffText(patch: detail.inputText)
                        }
                    case .code, .json:
                        ToolCodeBox(label: detail.inputLabel) {
                            PlainCodeText(text: detail.inputText)
                        }
                    case .none:
                        EmptyView()
                    }
                }
                if !item.mediaSources.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(item.mediaSources.enumerated()), id: \.offset) { _, source in
                            ConversationImage(source: source, sessionId: sessionId)
                                .frame(width: 120, height: 120)
                                .clipShape(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                )
                        }
                    }
                }
                if let result = detail.resultText {
                    ToolCodeBox(label: detail.resultLabel, isError: item.isError) {
                        if detail.resultIsDiff {
                            DiffText(patch: result)
                        } else {
                            PlainCodeText(text: result, isError: item.isError)
                        }
                    }
                }
            } else {
                ProgressView().controlSize(.mini)
            }
        }
    }
}

// MARK: - Code surfaces

/// A labelled code pane. Dark in both appearances, like the web's
/// `.tool-code-surface`: tool output is machine text and reads better against
/// a constant surface than against a theme-following one.
struct ToolCodeBox<Content: View>: View {
    let label: String
    var isError = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(
                    isError ? OS1VisualStyle.red : OS1VisualStyle.textFaint
                )
            ScrollView(.horizontal, showsIndicators: false) {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 260)
            .padding(8)
            .background(
                Color(red: 0.051, green: 0.059, blue: 0.075),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.white.opacity(0.07), lineWidth: 0.5)
            }
        }
    }
}

/// Mono text on the dark surface. Kept as ONE `Text` so selection can span
/// lines and so a long body is one layout pass rather than hundreds.
struct PlainCodeText: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(
                isError
                    ? OS1VisualStyle.red.opacity(0.85)
                    : Color.white.opacity(0.72)
            )
            .textSelection(.enabled)
    }
}

/// A unified diff, tinted per line.
///
/// One `AttributedString` in a single `Text`, not a view per line: an edit to
/// a large file would otherwise put hundreds of `HStack`s inside a row inside
/// a lazy stack. The trade-off is that the tint follows the glyphs instead of
/// painting a full-width bar — so each line keeps its `+`/`-` gutter
/// character, which is what actually survives at this size anyway.
struct DiffText: View {
    let patch: String

    /// Long diffs are for reading the shape of a change, not auditing it.
    private static let maxLines = 300

    var body: some View {
        Text(attributed)
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
    }

    private var attributed: AttributedString {
        var output = AttributedString()
        let lines = patch.components(separatedBy: .newlines)
        for line in lines.prefix(Self.maxLines) {
            var piece = AttributedString(line.isEmpty ? " " : line)
            piece.foregroundColor = Self.color(for: line)
            output.append(piece)
            output.append(AttributedString("\n"))
        }
        if lines.count > Self.maxLines {
            var more = AttributedString("… \(lines.count - Self.maxLines) more lines")
            more.foregroundColor = Color.white.opacity(0.4)
            output.append(more)
        }
        return output
    }

    private static func color(for line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") {
            return Color.white.opacity(0.45)
        }
        if line.hasPrefix("+") { return OS1VisualStyle.green }
        if line.hasPrefix("-") { return OS1VisualStyle.red }
        if line.hasPrefix("@@") || line.hasPrefix("*** ") {
            return OS1VisualStyle.blue
        }
        return Color.white.opacity(0.6)
    }
}

// MARK: - Bespoke bodies

/// What a tool call's expanded view should show, resolved per tool.
struct ToolDetail: Equatable {
    enum Kind: Equatable { case none, code, diff, json }

    var inputKind: Kind = .none
    var inputLabel = "Input"
    var inputText = ""
    var resultLabel = "Output"
    var resultText: String?
    var resultIsDiff = false

    private static let maxBodyCharacters = 4000

    static func make(item: ToolCallItem) -> ToolDetail {
        var detail = ToolDetail()
        let canonical = item.presentation.canonical
        let input = item.use?.toolInput

        switch canonical {
        case "Bash":
            detail.inputKind = .code
            detail.inputLabel = "Command"
            detail.inputText = bashBody(input)
        case "Edit":
            if let patch = diffBody(input) {
                detail.inputKind = .diff
                detail.inputLabel = "Diff"
                detail.inputText = patch
            } else {
                detail.inputKind = .json
                detail.inputText = clamp(input?.pretty ?? "")
            }
        case "Write":
            detail.inputKind = .code
            detail.inputLabel = "Content"
            detail.inputText = clamp(
                string(input, "content") ?? string(input, "contents") ?? ""
            )
        case "Read":
            // The path is already in the summary line; only extra arguments
            // (offset, limit) are worth repeating.
            let extras = otherKeys(input, ignoring: [
                "file_path", "filePath", "path", "notebook_path", "notebookPath",
            ])
            if !extras.isEmpty {
                detail.inputKind = .json
                detail.inputText = extras
            }
        default:
            if case .object(let dict)? = input, !dict.isEmpty {
                detail.inputKind = .json
                detail.inputText = clamp(input?.pretty ?? "")
            }
        }

        if let result = item.result {
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let hasMedia = !(result.images ?? []).isEmpty
            // "Image read successfully." next to the image it describes is
            // noise; the image is the result.
            let redundant = hasMedia && text == "Image read successfully."
            if !redundant {
                detail.resultLabel = item.isError
                    ? "Error"
                    : (result.contentClamped == true ? "Output (truncated)" : "Output")
                detail.resultText = text.isEmpty
                    ? (hasMedia ? nil : "(empty)")
                    : clamp(text)
                detail.resultIsDiff = looksLikeDiff(text)
            }
        }
        return detail
    }

    /// The command, with the model's own description carried above it as
    /// shell comments so the metadata survives inside valid bash.
    private static func bashBody(_ input: JSONValue?) -> String {
        var lines: [String] = []
        if let description = string(input, "description") {
            lines.append("# \(description)")
        }
        for key in ["timeout", "cwd", "workdir", "run_in_background"] {
            if let value = string(input, key) { lines.append("# \(key): \(value)") }
        }
        let command = string(input, "command") ?? string(input, "cmd") ?? ""
        lines.append(command)
        return clamp(lines.joined(separator: "\n"))
    }

    /// A real patch when the engine sent one, else a synthesized unified diff
    /// from the old/new strings — the shape of the change is what an edit row
    /// is for, and two opaque blobs of text don't show it.
    private static func diffBody(_ input: JSONValue?) -> String? {
        for key in ["patchText", "patch_text", "patch", "diff"] {
            if let patch = string(input, key) { return clamp(patch) }
        }
        if case .array(let edits)? = input?["edits"], !edits.isEmpty {
            let hunks = edits.compactMap { edit -> String? in
                synthesize(
                    old: edit["old_string"]?.stringValue ?? edit["oldString"]?.stringValue,
                    new: edit["new_string"]?.stringValue ?? edit["newString"]?.stringValue
                )
            }
            return hunks.isEmpty ? nil : clamp(hunks.joined(separator: "\n@@\n"))
        }
        return synthesize(
            old: string(input, "old_string") ?? string(input, "oldString"),
            new: string(input, "new_string") ?? string(input, "newString")
        ).map(clamp)
    }

    private static func synthesize(old: String?, new: String?) -> String? {
        guard old != nil || new != nil else { return nil }
        var lines: [String] = []
        if let old, !old.isEmpty {
            lines.append(contentsOf: old.components(separatedBy: .newlines).map { "-\($0)" })
        }
        if let new, !new.isEmpty {
            lines.append(contentsOf: new.components(separatedBy: .newlines).map { "+\($0)" })
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    private static func looksLikeDiff(_ text: String) -> Bool {
        if text.hasPrefix("diff --git") { return true }
        return text.range(of: "^@@ -[0-9]", options: [.regularExpression]) != nil
    }

    private static func otherKeys(_ input: JSONValue?, ignoring: Set<String>) -> String {
        guard case .object(let dict)? = input else { return "" }
        let remaining = dict.keys.sorted().filter { !ignoring.contains($0) }
        guard !remaining.isEmpty else { return "" }
        return remaining
            .map { "\($0): \(dict[$0]!.pretty.trimmingCharacters(in: .whitespacesAndNewlines))" }
            .joined(separator: "\n")
    }

    private static func string(_ input: JSONValue?, _ key: String) -> String? {
        guard let value = input?[key]?.stringValue, !value.isEmpty else { return nil }
        return value
    }

    private static func clamp(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > maxBodyCharacters else { return trimmed }
        return String(trimmed.prefix(maxBodyCharacters)) + "\n… truncated"
    }
}
