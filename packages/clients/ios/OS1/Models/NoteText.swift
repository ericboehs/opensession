import Foundation
import SwiftUI

/// A team note's text, split the way the web bubble splits it: an `@Name`
/// reads as a name rather than as punctuation, and a URL someone pasted is
/// tappable. Mirrors `NoteText` in src/frontend/components/NoteBubble.tsx.
///
/// Deliberately NOT the markdown pipeline. A note is typed into a plain
/// `TextEditor`, so its text is not markdown and never was: `MarkdownBody`
/// would turn a leading dash into a bullet, `*` into emphasis, `#` into a
/// heading, and would collapse the blank lines the composer preserved. The web
/// renders the same string as `whitespace-pre-wrap` plain text for exactly that
/// reason, so routing native through markdown would make the two clients
/// disagree about what a note IS. `MarkdownBody` also carries the transcript's
/// file, PR and session link rewriting, which belongs to what the agent wrote
/// rather than to a line a person typed to a teammate. Two tokens, one pass
/// over the string.
enum NoteText {
    enum Token: Equatable {
        case plain(String)
        case mention(String)
        case link(String, URL)
    }

    /// Mirrors `NOTE_TOKEN_RE` on the web, with one deliberate change: the
    /// mention has to start the string or follow a character that isn't part
    /// of a word. Without that guard `sam@example.com` bolds `@example.com`,
    /// which the web does today and which reads as a mention of a person who
    /// does not exist.
    ///
    /// `\w` is ICU's here and ASCII-only in JavaScript, so `@José` highlights
    /// whole natively and stops at `@Jos` on the web. That divergence is left
    /// standing: the fuller match is the right one.
    private static let pattern = #"(?<![\w@])(@[A-Za-z][\w.-]*)|(https?://[^\s<>"')\]]+)"#

    private static let regex: NSRegularExpression? = try? NSRegularExpression(pattern: pattern)

    /// The pieces of a note, in order. Every character of `text` appears in
    /// exactly one token, so joining the token values reproduces the input.
    static func tokens(_ text: String) -> [Token] {
        guard let regex, !text.isEmpty else {
            return text.isEmpty ? [] : [.plain(text)]
        }
        let full = NSRange(text.startIndex..<text.endIndex, in: text)
        var out: [Token] = []
        var cursor = text.startIndex
        for match in regex.matches(in: text, range: full) {
            guard let range = Range(match.range, in: text) else { continue }
            let value = String(text[range])
            let token: Token?
            if value.hasPrefix("@") {
                token = .mention(value)
            } else if let url = URL(string: value) {
                token = .link(value, url)
            } else {
                // A URL Foundation won't parse stays prose rather than
                // becoming a link that goes nowhere.
                token = nil
            }
            guard let token else { continue }
            if cursor < range.lowerBound {
                out.append(.plain(String(text[cursor..<range.lowerBound])))
            }
            out.append(token)
            cursor = range.upperBound
        }
        if cursor < text.endIndex {
            out.append(.plain(String(text[cursor...])))
        }
        return out
    }

    /// The same text, styled for a `Text`. Mentions take the emphasis the web
    /// gives them; links take the app's own link ink rather than the web's
    /// accent, because that is what every other tappable word in running text
    /// wears here.
    static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString()
        for token in tokens(text) {
            switch token {
            case .plain(let value):
                out.append(AttributedString(value))
            case .mention(let value):
                var run = AttributedString(value)
                // A presentation intent rather than a font: the run has to keep
                // whatever size Dynamic Type resolved for the bubble, and
                // setting `.font` on it would pin one.
                run.inlinePresentationIntent = .stronglyEmphasized
                out.append(run)
            case .link(let value, let url):
                var run = AttributedString(value)
                run.link = url
                run.foregroundColor = OS1VisualStyle.link
                run.underlineStyle = .single
                out.append(run)
            }
        }
        return out
    }
}
