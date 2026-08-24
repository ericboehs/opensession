import Foundation

/// Line-by-line rewriting of markdown that leaves code alone.
///
/// Two rewrites run over agent output just before it is rendered — session
/// ids become links (`SessionLinks`) and bare URLs become links
/// (`MarkdownAutolink`) — and both have the same hard constraint: whatever an
/// agent quoted as code has to survive byte for byte, because a rewritten
/// command or diff is a lie about what ran.
enum MarkdownProse {
    /// `markdown` with `transform` applied to prose lines only. Fenced and
    /// indented code pass through untouched.
    static func rewrite(_ markdown: String, _ transform: (String) -> String) -> String {
        var out: [String] = []
        var inFence = false
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(line)
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                out.append(text)
                continue
            }
            // Indented code is code too.
            if inFence || text.hasPrefix("    ") || text.hasPrefix("\t") {
                out.append(text)
                continue
            }
            out.append(transform(text))
        }
        return out.joined(separator: "\n")
    }
}
