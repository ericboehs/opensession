import Foundation

/// Splits transcript markdown into the ```mermaid fences and the plain
/// markdown around them, so `MarkdownBody` can hand the fences to the diagram
/// renderer and everything else to SwiftStreamingMarkdown unchanged.
///
/// The split runs on the RAW text, before the link rewrites: linkifying first
/// would turn a URL or a file path inside a diagram label into markdown link
/// syntax and the source would stop parsing.
///
/// Deliberately conservative. Only a fence at the start of a line (CommonMark
/// allows up to three leading spaces) whose info string is exactly `mermaid`
/// becomes a diagram; a fence nested in a list item, or one that hasn't been
/// closed yet, stays plain markdown and renders as an ordinary code block.
/// That last case is what a streaming or head-clamped message looks like, and
/// it matches the web, where incomplete source keeps its code fence.
enum MermaidSegmenter {
    enum Segment: Equatable {
        case markdown(String)
        case mermaid(String)
    }

    /// The segments of `text`, in order. A string with no complete mermaid
    /// fence comes back as a single `.markdown` segment — the common case, and
    /// the one that must stay allocation-cheap.
    static func split(_ text: String) -> [Segment] {
        guard text.contains("```mermaid") || text.contains("~~~mermaid") else {
            return [.markdown(text)]
        }
        var segments: [Segment] = []
        // Everything since the last emitted segment, still unclaimed.
        var pending: [Substring] = []
        // The lines of the mermaid fence currently being collected, if any,
        // plus what would close it.
        var diagram: (lines: [Substring], marker: Character, length: Int)?
        // Head of an unterminated mermaid fence: if the text ends while it is
        // open, these lines go back to markdown verbatim.
        var openingLine: Substring?
        // A non-mermaid fence swallows everything until it closes, so a
        // ```mermaid inside a ```markdown example is never split out.
        var otherFence: (marker: Character, length: Int)?

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if var open = diagram {
                if closes(line, marker: open.marker, length: open.length) {
                    append(&segments, markdown: pending)
                    pending = []
                    segments.append(.mermaid(open.lines.joined(separator: "\n")))
                    diagram = nil
                    openingLine = nil
                } else {
                    open.lines.append(line)
                    diagram = open
                }
                continue
            }
            if let other = otherFence {
                pending.append(line)
                if closes(line, marker: other.marker, length: other.length) {
                    otherFence = nil
                }
                continue
            }
            guard let fence = opening(line) else {
                pending.append(line)
                continue
            }
            if fence.info.lowercased() == "mermaid" {
                diagram = ([], fence.marker, fence.length)
                openingLine = line
            } else {
                pending.append(line)
                otherFence = (fence.marker, fence.length)
            }
        }

        // An unterminated mermaid fence rejoins the markdown exactly as
        // written, closing marker and all still absent.
        if let open = diagram, let openingLine {
            pending.append(openingLine)
            pending.append(contentsOf: open.lines)
        }
        append(&segments, markdown: pending)
        return segments.isEmpty ? [.markdown(text)] : segments
    }

    /// Adds the collected lines as a markdown segment, unless they are only
    /// the blank lines around a diagram — an empty `MarkdownView` would still
    /// occupy a slot in the stack and space itself from its neighbours.
    private static func append(_ segments: inout [Segment], markdown lines: [Substring]) {
        guard lines.contains(where: { !$0.allSatisfy(\.isWhitespace) }) else { return }
        segments.append(.markdown(lines.joined(separator: "\n")))
    }

    /// The fence marker, its run length and its info string, for a line that
    /// opens a fenced code block — nil for anything else.
    private static func opening(
        _ line: Substring
    ) -> (marker: Character, length: Int, info: String)? {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        // Four spaces in is an indented code block, not a fence.
        if rest.first == " " { return nil }
        guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
        let run = rest.prefix { $0 == marker }
        guard run.count >= 3 else { return nil }
        let info = rest.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        // A backtick fence's info string may not contain a backtick.
        if marker == "`", info.contains("`") { return nil }
        return (marker, run.count, info)
    }

    /// Whether `line` closes a fence opened with `length` of `marker`: the same
    /// marker, at least as long, and nothing after it.
    private static func closes(_ line: Substring, marker: Character, length: Int) -> Bool {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        let run = rest.prefix { $0 == marker }
        guard run.count >= length else { return false }
        return rest.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
    }
}
