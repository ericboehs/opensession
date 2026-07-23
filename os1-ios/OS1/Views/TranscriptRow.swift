import SwiftUI

/// Renders one transcript entry according to its type: user prompts as tinted
/// right-aligned bubbles, assistant text as left-aligned markdown, tool
/// activity and system events as compact caption rows.
struct TranscriptRow: View {
    let entry: TranscriptEntry

    var body: some View {
        if entry.isUser {
            userBubble
        } else if entry.isAssistant {
            assistantBubble
        } else if entry.isTool {
            toolRow
        } else {
            systemRow
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            Text(entry.text)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(.white)
                .background(.tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantBubble: some View {
        HStack {
            MarkdownText(entry.text)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    .fill.secondary,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
            Spacer(minLength: 48)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var toolRow: some View {
        HStack(spacing: 6) {
            Image(systemName: entry.type == "tool_use" ? "wrench.and.screwdriver" : "arrow.turn.down.right")
                .font(.caption2)
            Text(toolSummary)
                .lineLimit(2)
            if entry.isError == true {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 12)
    }

    private var toolSummary: String {
        if entry.type == "tool_use" {
            return entry.toolName ?? "Tool call"
        }
        let text = entry.text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
        return text.isEmpty ? "Result" : String(text.prefix(120))
    }

    private var systemRow: some View {
        Text(entry.text)
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(3)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 24)
    }
}

/// Assistant text streaming in over `stream_text` frames, before the durable
/// transcript entry exists.
struct StreamingBubble: View {
    let text: String

    var body: some View {
        HStack {
            HStack(alignment: .bottom, spacing: 4) {
                if text.isEmpty {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    MarkdownText(text)
                }
                Text("▍")
                    .foregroundStyle(.tint)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                .fill.secondary,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            Spacer(minLength: 48)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Best-effort markdown: inline styling via AttributedString (bold, italics,
/// code, links); falls back to plain text. Full block rendering (code fences,
/// lists) is a later milestone.
struct MarkdownText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(attributed)
            .textSelection(.enabled)
    }

    private var attributed: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }
}
