import Foundation

/// Bare URLs in agent output, turned into links you can tap.
///
/// The transcript's parser is CommonMark plus tables, strikethrough and task
/// lists — GFM's autolink extension is not among them. A URL written as
/// ordinary prose ("opened https://github.com/…/pull/1") is therefore just
/// text: the same colour as the sentence around it, with nothing to tap,
/// while the same URL written as `[a link](…)` renders as one. Agents write
/// the bare form constantly, so it is spelled out as an explicit markdown
/// link just before rendering.
///
/// Conservative in the same way as `SessionLinks`: code is left alone, and a
/// URL that is already part of a link — an inline destination, a link label,
/// an angle autolink, a reference definition — is never touched, so a
/// rewrite can't corrupt a target the agent chose.
enum MarkdownAutolink {
    /// Markdown with every bare `http(s)` URL rewritten as a link. Returns
    /// the input unchanged when there is nothing to do, which is most text.
    static func linkify(_ markdown: String) -> String {
        guard markdown.contains("://") else { return markdown }
        return MarkdownProse.rewrite(markdown) { line in
            guard line.contains("://"), !isReferenceDefinition(line) else { return line }
            return linkifyLine(line)
        }
    }

    /// Runs a URL must not be lifted out of, then the URL itself. The skip
    /// alternatives come first so that at any position an existing link wins
    /// over the URL inside it.
    private static let pattern = try! NSRegularExpression(
        pattern:
            "(`[^`]*`"                        // inline code
            + "|!?\\[[^\\]]*\\]\\([^)]*\\)"   // [label](destination), ![alt](src)
            + "|<[^>\\s]+>)"                  // <https://…>, already an autolink
            + "|(https?://[^\\s<>`\\[\\]]+)",
        options: [.caseInsensitive]
    )

    /// `[docs]: https://…` — the URL is the definition's target, and
    /// rewriting it would turn the whole definition into a paragraph.
    private static let referenceDefinition = try! NSRegularExpression(
        pattern: "^ {0,3}\\[[^\\]]*\\]:",
        options: []
    )

    private static func isReferenceDefinition(_ line: String) -> Bool {
        referenceDefinition.firstMatch(
            in: line,
            range: NSRange(location: 0, length: (line as NSString).length)
        ) != nil
    }

    private static func linkifyLine(_ line: String) -> String {
        let ns = line as NSString
        var result = ""
        var cursor = 0
        for match in pattern.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            let urlRange = match.range(at: 2)
            // Group 1 matched: an existing link or code span, copied verbatim.
            guard urlRange.location != NSNotFound else { continue }
            let url = trimmingTrailingPunctuation(ns.substring(with: urlRange))
            guard !url.isEmpty else { continue }
            result += ns.substring(with: NSRange(
                location: cursor,
                length: urlRange.location - cursor
            ))
            result += "[\(url)](\(url))"
            // Only the URL is consumed; punctuation the sentence needed back
            // is copied out with the text that follows it.
            cursor = urlRange.location + (url as NSString).length
        }
        guard cursor > 0 else { return line }
        result += ns.substring(from: cursor)
        return result
    }

    private static let closingPairs: [Character: Character] = [")": "(", "]": "[", "}": "{"]

    /// A URL at the end of a sentence swallows the punctuation that ended it.
    /// Sentence punctuation always comes off; a closing bracket only when it
    /// has no opener inside the URL, so a Wikipedia `…_(disambiguation)` link
    /// stays whole.
    private static func trimmingTrailingPunctuation(_ url: String) -> String {
        var out = Substring(url)
        while let last = out.last {
            if ".,;:!?\"'".contains(last) {
                out = out.dropLast()
                continue
            }
            if let opener = closingPairs[last],
               out.filter({ $0 == opener }).count < out.filter({ $0 == last }).count {
                out = out.dropLast()
                continue
            }
            break
        }
        return String(out)
    }
}
