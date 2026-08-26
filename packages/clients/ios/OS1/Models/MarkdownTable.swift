import Foundation

/// One GFM pipe table, parsed out of transcript markdown.
///
/// Cells keep their inline markdown (`**bold**`, `` `code` ``, links) — the
/// view renders that per cell, so a link written inside a table still opens
/// the same way as one written in a paragraph.
struct MarkdownTable: Hashable {
    enum Alignment: Hashable {
        case leading
        case center
        case trailing
    }

    var headers: [String]
    var alignments: [Alignment]
    var rows: [[String]]

    var columnCount: Int { headers.count }

    /// The table written back out as GFM, for the one case the app's own
    /// layout can't serve: too many columns to fit at any width, which goes
    /// to SwiftStreamingMarkdown's scrolling table instead. Round-tripping the
    /// parsed cells rather than keeping the original lines means the rewrites
    /// applied to them (file, session and asset links) survive the handover.
    func markdownSource() -> String {
        func row(_ cells: [String]) -> String {
            "| " + cells.map { $0.replacingOccurrences(of: "|", with: "\\|") }
                .joined(separator: " | ") + " |"
        }
        var lines = [row(headers)]
        lines.append("|" + alignments.map { alignment in
            switch alignment {
            case .leading: " --- "
            case .center: " :-: "
            case .trailing: " --: "
            }
        }.joined(separator: "|") + "|")
        lines.append(contentsOf: rows.map(row))
        return lines.joined(separator: "\n")
    }
}

/// Splits transcript markdown into the GFM tables and the plain markdown
/// around them, so `MarkdownBody` can lay tables out itself and hand
/// everything else to SwiftStreamingMarkdown unchanged.
///
/// The reason we take tables off the library: its cells are pinned to a
/// 200pt maximum and at least `viewport / columns`, so a four-column table of
/// prose is always about twice a phone's width — always clipped, always
/// needing a sideways drag nobody can see is available. `MarkdownTableView`
/// wraps cells to fit instead, the way the web viewer's `.markdown table`
/// does, and only falls back to scrolling when even the narrowest columns
/// cannot fit.
///
/// Deliberately conservative, like `MermaidSegmenter`. A table is only lifted
/// out when it starts a block at the top level: a pipe table inside a fenced
/// code block, a blockquote or a list item stays with the library, and so
/// does one whose header row is not followed by a matching delimiter row —
/// which is what a half-streamed or head-clamped message looks like.
enum MarkdownTableSegmenter {
    enum Segment: Equatable {
        case markdown(String)
        case table(MarkdownTable)
    }

    /// The segments of `text`, in order. Text with no table comes back as a
    /// single `.markdown` segment — the common case, and the one that must
    /// stay allocation-cheap.
    static func split(_ text: String) -> [Segment] {
        guard text.contains("|") else { return [.markdown(text)] }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var segments: [Segment] = []
        var pending: [Substring] = []
        // A fenced block swallows everything until it closes, so a pipe table
        // inside a ```markdown example is never lifted out.
        var fence: (marker: Character, length: Int)?
        // A table may only START a block: the top of the message, or after a
        // blank line. cmark-gfm won't let one interrupt a paragraph either,
        // so this matches what the text actually means.
        var previousBlank = true
        var index = 0

        while index < lines.count {
            let line = lines[index]
            if let open = fence {
                pending.append(line)
                if closes(line, marker: open.marker, length: open.length) { fence = nil }
                previousBlank = false
                index += 1
                continue
            }
            if let opened = opening(line) {
                pending.append(line)
                fence = (opened.marker, opened.length)
                previousBlank = false
                index += 1
                continue
            }
            if previousBlank, let found = parseTable(lines, from: index) {
                append(&segments, markdown: pending)
                pending = []
                segments.append(.table(found.table))
                index = found.end
                previousBlank = false
                continue
            }
            pending.append(line)
            previousBlank = line.allSatisfy(\.isWhitespace)
            index += 1
        }

        append(&segments, markdown: pending)
        return segments.isEmpty ? [.markdown(text)] : segments
    }

    /// Adds the collected lines as a markdown segment, unless they are only
    /// the blank lines around a table — an empty `MarkdownView` would still
    /// occupy a slot in the stack and space itself from its neighbours.
    private static func append(_ segments: inout [Segment], markdown lines: [Substring]) {
        guard lines.contains(where: { !$0.allSatisfy(\.isWhitespace) }) else { return }
        segments.append(.markdown(lines.joined(separator: "\n")))
    }

    /// The table starting at `start`, and the index of the first line after
    /// it — nil when these lines are not a table.
    private static func parseTable(
        _ lines: [Substring],
        from start: Int
    ) -> (table: MarkdownTable, end: Int)? {
        guard start + 1 < lines.count, isRow(lines[start]) else { return nil }
        let headers = cells(lines[start])
        // One column is almost always prose that happens to carry a pipe.
        guard headers.count >= 2 else { return nil }
        guard let alignments = delimiters(lines[start + 1]),
              alignments.count == headers.count else { return nil }

        var rows: [[String]] = []
        var index = start + 2
        while index < lines.count, isRow(lines[index]) {
            var row = cells(lines[index])
            if row.count > headers.count { row = Array(row.prefix(headers.count)) }
            while row.count < headers.count { row.append("") }
            rows.append(row)
            index += 1
        }
        // A header with no body is valid GFM but nothing to show; leave it to
        // the library, which is also where a half-arrived table belongs.
        guard !rows.isEmpty else { return nil }
        return (MarkdownTable(headers: headers, alignments: alignments, rows: rows), index)
    }

    /// Whether `line` can be a table row: at the top level (not indented into
    /// a code block, not inside a quote or a list item) and carrying at least
    /// one unescaped pipe.
    private static func isRow(_ line: Substring) -> Bool {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        if rest.first == " " || rest.first == "\t" { return false }
        guard let first = rest.first else { return false }
        if first == ">" { return false }
        if first == "-" || first == "*" || first == "+" {
            // A list marker is the character plus a space; `-|-` is not one.
            if rest.dropFirst().first == " " { return false }
        }
        if first.isNumber {
            let digits = rest.prefix(while: \.isNumber)
            let after = rest.dropFirst(digits.count)
            if after.first == "." || after.first == ")" { return false }
        }
        return containsUnescapedPipe(rest)
    }

    private static func containsUnescapedPipe(_ text: Substring) -> Bool {
        var escaped = false
        for character in text {
            if escaped { escaped = false; continue }
            if character == "\\" { escaped = true; continue }
            if character == "|" { return true }
        }
        return false
    }

    /// The cells of a row: the optional leading and trailing pipe dropped,
    /// then a split on the pipes that aren't escaped, each cell trimmed and
    /// its `\|` unescaped.
    private static func cells(_ line: Substring) -> [String] {
        var rest = Substring(line.trimmingCharacters(in: .whitespaces))
        if rest.first == "|" { rest = rest.dropFirst() }
        if rest.last == "|", !rest.dropLast().hasSuffix("\\") { rest = rest.dropLast() }

        var out: [String] = []
        var current = ""
        var escaped = false
        for character in rest {
            if escaped {
                // Only the pipe loses its backslash; every other escape is
                // inline markdown the cell renderer still has to see.
                if character != "|" { current.append("\\") }
                current.append(character)
                escaped = false
                continue
            }
            if character == "\\" { escaped = true; continue }
            if character == "|" {
                out.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                continue
            }
            current.append(character)
        }
        if escaped { current.append("\\") }
        out.append(current.trimmingCharacters(in: .whitespaces))
        return out
    }

    /// The column alignments of a delimiter row (`|:---|---:|`), or nil when
    /// the line is not one.
    private static func delimiters(_ line: Substring) -> [MarkdownTable.Alignment]? {
        guard isRow(line) else { return nil }
        var out: [MarkdownTable.Alignment] = []
        for cell in cells(line) {
            var body = Substring(cell)
            let leading = body.first == ":"
            if leading { body = body.dropFirst() }
            let trailing = body.last == ":"
            if trailing { body = body.dropLast() }
            guard !body.isEmpty, body.allSatisfy({ $0 == "-" }) else { return nil }
            switch (leading, trailing) {
            case (true, true): out.append(.center)
            case (false, true): out.append(.trailing)
            default: out.append(.leading)
            }
        }
        return out.isEmpty ? nil : out
    }

    /// The fence marker and its run length, for a line that opens a fenced
    /// code block — nil for anything else.
    private static func opening(_ line: Substring) -> (marker: Character, length: Int)? {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        if rest.first == " " { return nil }
        guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
        let run = rest.prefix { $0 == marker }
        guard run.count >= 3 else { return nil }
        if marker == "`", rest.dropFirst(run.count).contains("`") { return nil }
        return (marker, run.count)
    }

    /// Whether `line` closes a fence opened with `length` of `marker`.
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
