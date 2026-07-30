import SwiftUI

/// Renders one display item: user prompts as neutral right-aligned bubbles,
/// assistant text as left-aligned markdown, tool calls as compact collapsible
/// rows (summary line; tap to expand input + result), system events as
/// centered captions.
struct TranscriptRow: View {
    let item: SessionViewModel.DisplayItem
    let sessionId: String
    var body: some View {
        switch item {
        case .toolCall(let use, let result, let isLive):
            ToolCallRow(use: use, result: result, isLive: isLive)
        case .entry(let entry):
            if entry.isUser {
                userBubble(entry)
            } else if entry.isAssistant {
                assistantBubble(entry)
            } else if entry.isTool {
                // Orphan tool_result — same compact treatment.
                ToolCallRow(use: nil, result: entry, isLive: false)
            } else {
                systemRow(entry)
            }
        }
    }

    private func userBubble(_ entry: TranscriptEntry) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 6) {
                conversationImages(entry)
                if !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.body)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .foregroundStyle(OS1VisualStyle.text)
                        .userMessagePanelCompat(
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                        }
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: userMessageMaxWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var userMessageMaxWidth: CGFloat {
        #if os(macOS)
        520
        #else
        .infinity
        #endif
    }

    /// Assistant text renders plain (no bubble), the shape modern AI chat
    /// apps converge on — only the person's own messages get bubbles.
    private func assistantBubble(_ entry: TranscriptEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            conversationImages(entry)
            if !entry.text.isEmpty {
                MarkdownBody(entry.text)
            }
        }
        .padding(.vertical, 2)
        .padding(.trailing, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func conversationImages(_ entry: TranscriptEntry) -> some View {
        let sources = entry.images ?? []
        if !sources.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                    ConversationImage(source: source, sessionId: sessionId)
                        .frame(width: 96, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
    }

    private func systemRow(_ entry: TranscriptEntry) -> some View {
        Text(entry.text)
            #if os(iOS)
            .font(.footnote)
            #else
            .font(.caption)
            #endif
            .foregroundStyle(OS1VisualStyle.textDim)
            .lineLimit(3)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 24)
    }
}

// MARK: - Tool calls

/// One tool call: a caption summary row that expands to the pretty-printed
/// input and the (clamped) result output. Raw JSON never shows collapsed.
struct ToolCallRow: View {
    let use: TranscriptEntry?
    let result: TranscriptEntry?
    /// Only a stream entry is eligible for the "Expand while running" mode.
    /// A transcript reload can contain old tool uses with no persisted result.
    let isLive: Bool

    @AppStorage("os1.appearance.turnActivity") private var turnActivity = "collapsed"
    @State private var expanded = false

    private var isError: Bool {
        use?.isError == true || result?.isError == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
            } label: {
                summaryRow
            }
            .buttonStyle(.plain)

            if expanded {
                detail
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { applyExpansionPreference() }
        .onChange(of: result?.id) { _, _ in applyExpansionPreference() }
        .onChange(of: isLive) { _, _ in applyExpansionPreference() }
        .onChange(of: turnActivity) { _, _ in applyExpansionPreference() }
    }

    private func applyExpansionPreference() {
        if turnActivity == "expanded" { expanded = true }
        else if turnActivity == "collapsed" { expanded = false }
        else { expanded = isLive && result == nil && use != nil }
    }

    private var summaryRow: some View {
        HStack(spacing: 6) {
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(OS1VisualStyle.textFaint)
            Image(systemName: "wrench.and.screwdriver")
                .font(.caption2)
            Text(title)
                .lineLimit(1)
            if result == nil, use != nil {
                ProgressView()
                    .controlSize(.mini)
            }
            if isError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        #if os(iOS)
        .font(.subheadline)
        #else
        .font(.callout)
        #endif
        .foregroundStyle(OS1VisualStyle.textDim)
        .contentShape(Rectangle())
    }

    /// A friendly one-liner: the server's summary ("Read path", "$ cmd") when
    /// it says more than "Using X", else a cleaned tool name plus its most
    /// interesting input value.
    private var title: String {
        guard let use else {
            let text = firstLine(result?.text ?? "")
            return text.isEmpty ? "Tool result" : text
        }
        let summary = firstLine(use.text)
        let name = cleanedToolName(use.toolName ?? "tool")
        if !summary.isEmpty && summary != "Using \(use.toolName ?? "")" {
            return summary
        }
        if let hint = inputHint(use.toolInput) {
            return "\(name): \(hint)"
        }
        return name
    }

    /// "mcp__oc__linear_list_issues" → "linear list_issues"; "Bash" stays.
    private func cleanedToolName(_ raw: String) -> String {
        var name = raw
        for prefix in ["mcp__oc__", "mcp__"] where name.hasPrefix(prefix) {
            name = String(name.dropFirst(prefix.count))
        }
        return name.replacingOccurrences(of: "__", with: " ")
    }

    /// The single most informative input value, for tools the server has no
    /// summary for (MCP tools mostly).
    private func inputHint(_ input: JSONValue?) -> String? {
        guard case .object(let dict)? = input else { return nil }
        for key in ["command", "filePath", "file_path", "path", "query", "pattern", "url", "prompt", "question", "title", "name"] {
            if let value = dict[key]?.stringValue, !value.isEmpty {
                return String(firstLine(value).prefix(60))
            }
        }
        return nil
    }

    private func firstLine(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n").first ?? ""
    }

    @ViewBuilder
    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let input = use?.toolInput, case .object(let dict) = input, !dict.isEmpty {
                codeBox(label: "Input", text: input.pretty.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            if let result {
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                codeBox(
                    label: result.contentClamped == true ? "Result (truncated)" : "Result",
                    text: text.isEmpty ? "(empty)" : String(text.prefix(4000))
                )
            }
        }
        .padding(.leading, 14)
    }

    private func codeBox(label: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                #if os(iOS)
                .font(.footnote.weight(.semibold))
                #else
                .font(.caption2.weight(.semibold))
                #endif
                .foregroundStyle(OS1VisualStyle.textDim)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    #if os(iOS)
                    .font(.system(.footnote, design: .monospaced))
                    #else
                    .font(.system(.caption, design: .monospaced))
                    #endif
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .textSelection(.enabled)
                    .lineLimit(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
            .transcriptPanelCompat(
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
        }
    }
}

// MARK: - Streaming bubble

/// Assistant text streaming in over `stream_text` frames, before the durable
/// transcript entry exists. Only rendered once text is available.
struct StreamingBubble: View {
    let text: String

    var body: some View {
        StreamingMarkdownBody(text)
            .padding(.vertical, 2)
            .padding(.trailing, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Ticking elapsed-run clock ("8.3s", "2m 14s", "1h 5m") — the web viewer's
/// BusyElapsed format. Falls back to "Running" with no anchor.
struct RunElapsedLabel: View {
    let since: Date?

    var body: some View {
        if let since {
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                Text(label(elapsed: context.date.timeIntervalSince(since)))
                    .monospacedDigit()
            }
        } else {
            Text("Running")
        }
    }

    private func label(elapsed: TimeInterval) -> String {
        let s = max(0, elapsed)
        if s < 60 { return String(format: "%.1fs", s) }
        let total = Int(s)
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3600)h \((total % 3600) / 60)m"
    }
}
