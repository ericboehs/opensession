import SwiftUI

/// Lightweight markdown renderer for assistant messages. SwiftUI's built-in
/// `Text(markdown:)` only handles a single inline run — no headings, lists,
/// or code blocks — so this splits the text into blocks first and renders
/// inline markdown (bold/italic/code/links) per line via AttributedString.
struct MarkdownBody: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        let blocks = MarkdownParseCache.parse(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let content):
            inlineText(content)
                .font(headingFont(level))
                .padding(.top, 2)
        case .paragraph(let content):
            inlineText(content)
        case .codeBlock(let code, _):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        inlineText(item)
                    }
                }
            }
        case .numberedList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(index + 1).")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        inlineText(item)
                    }
                }
            }
        case .blockquote(let content):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(.quaternary)
                    .frame(width: 3)
                inlineText(content)
                    .foregroundStyle(.secondary)
            }
        case .divider:
            Divider()
        }
    }

    private func inlineText(_ content: String) -> some View {
        Text(MarkdownBody.inline(content))
            .textSelection(.enabled)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title3.weight(.bold)
        case 2: .headline
        default: .subheadline.weight(.semibold)
        }
    }

    /// Inline markdown (bold, italic, `code`, [links]) for one block's text.
    /// Falls back to the literal string when parsing fails.
    static func inline(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }
}

/// Block-level markdown structure. Deliberately small: fenced code, headings,
/// bullet/numbered lists, blockquotes, dividers, paragraphs. Everything else
/// renders as a paragraph with inline styling.
enum MarkdownBlock {
    case heading(level: Int, content: String)
    case paragraph(String)
    case codeBlock(code: String, language: String?)
    case bulletList([String])
    case numberedList([String])
    case blockquote(String)
    case divider

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []
        var quote: [String] = []
        var codeLines: [String] = []
        var codeLanguage: String?
        var inCode = false

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        func flushLists() {
            if !bullets.isEmpty {
                blocks.append(.bulletList(bullets))
                bullets = []
            }
            if !numbers.isEmpty {
                blocks.append(.numberedList(numbers))
                numbers = []
            }
        }
        func flushQuote() {
            if !quote.isEmpty {
                blocks.append(.blockquote(quote.joined(separator: "\n")))
                quote = []
            }
        }
        func flushAll() {
            flushParagraph()
            flushLists()
            flushQuote()
        }

        for rawLine in text.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)

            if inCode {
                if line.hasPrefix("```") {
                    blocks.append(.codeBlock(
                        code: codeLines.joined(separator: "\n"),
                        language: codeLanguage
                    ))
                    codeLines = []
                    inCode = false
                } else {
                    codeLines.append(rawLine)
                }
                continue
            }

            if line.hasPrefix("```") {
                flushAll()
                inCode = true
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                codeLanguage = lang.isEmpty ? nil : lang
                continue
            }

            if line.isEmpty {
                flushAll()
                continue
            }

            if line == "---" || line == "***" || line == "___" {
                flushAll()
                blocks.append(.divider)
                continue
            }

            if let heading = parseHeading(line) {
                flushAll()
                blocks.append(heading)
                continue
            }

            if let bullet = parseBullet(line) {
                flushParagraph()
                flushQuote()
                if !numbers.isEmpty { flushLists() }
                bullets.append(bullet)
                continue
            }

            if let numbered = parseNumbered(line) {
                flushParagraph()
                flushQuote()
                if !bullets.isEmpty { flushLists() }
                numbers.append(numbered)
                continue
            }

            if line.hasPrefix(">") {
                flushParagraph()
                flushLists()
                quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }

            flushLists()
            flushQuote()
            paragraph.append(rawLine)
        }

        if inCode, !codeLines.isEmpty {
            // Unterminated fence mid-stream: show what we have as code.
            blocks.append(.codeBlock(
                code: codeLines.joined(separator: "\n"),
                language: codeLanguage
            ))
        }
        flushAll()
        return blocks
    }

    private static func parseHeading(_ line: String) -> MarkdownBlock? {
        guard line.hasPrefix("#") else { return nil }
        let level = line.prefix(while: { $0 == "#" }).count
        guard level <= 6 else { return nil }
        let content = String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return nil }
        return .heading(level: min(level, 3), content: content)
    }

    private static func parseBullet(_ line: String) -> String? {
        for prefix in ["- ", "* ", "+ "] where line.hasPrefix(prefix) {
            return String(line.dropFirst(prefix.count))
        }
        return nil
    }

    private static func parseNumbered(_ line: String) -> String? {
        let digits = line.prefix(while: \.isNumber)
        guard !digits.isEmpty else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return String(rest.dropFirst(2))
    }
}

/// Parsed-block memo. Rows re-enter the lazy stack constantly while
/// scrolling and their text never changes, so parsing once per unique text
/// turns every re-appearance into a dictionary hit. (The streaming bubble's
/// growing text misses by design — it's bounded by the ~8Hz flush.)
@MainActor
enum MarkdownParseCache {
    private static var blocks: [String: [MarkdownBlock]] = [:]
    private static var order: [String] = []

    static func parse(_ text: String) -> [MarkdownBlock] {
        if let hit = blocks[text] { return hit }
        let parsed = MarkdownBlock.parse(text)
        blocks[text] = parsed
        order.append(text)
        if order.count > 400 {
            for key in order.prefix(100) { blocks.removeValue(forKey: key) }
            order.removeFirst(100)
        }
        return parsed
    }
}
