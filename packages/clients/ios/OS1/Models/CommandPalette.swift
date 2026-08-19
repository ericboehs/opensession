import Foundation

#if os(macOS)

/// One row the Mac command palette can show: a command it runs, or a session
/// it switches to.
///
/// Data only, no closure, so ranking is a pure function over values and can be
/// tested without a view — `CommandPaletteItem` is what pairs an entry with
/// what selecting it does.
struct CommandPaletteEntry: Identifiable, Equatable, Sendable {
    enum Kind: Int, Sendable {
        /// Something the app does. Listed above sessions, in declared order.
        case command
        /// Somewhere the app goes. Ranked by how well it matched, then by how
        /// recently it was active.
        case session
    }

    let id: String
    let title: String
    /// The line under the title: what a command does, or where a session lives.
    var subtitle: String?
    /// Words that should find the row without being written on it — a
    /// session's repo, branch and workspace, a command's synonyms.
    var keywords: [String] = []
    /// The keys that run the same thing without opening the palette, one cap
    /// each. Empty when there is no shortcut, rather than a fake one.
    var shortcut: [String] = []
    var symbol: String = "circle"
    var kind: Kind = .command
    /// Breaks ties between sessions. Nil on commands, which keep the order
    /// they were declared in.
    var recency: Date?
}

/// Which rows a query keeps, and in what order.
///
/// Deliberately not a fuzzy subsequence matcher: on a list where most rows are
/// sessions with long, similar titles, subsequence matching turns every query
/// into a wall of near-misses. Every whitespace-separated token has to appear
/// somewhere in the row, and where it appears is the score — the title's start
/// beats a word inside it, which beats the subtitle or a keyword.
enum CommandPaletteRanking {
    /// A row with its searchable text folded once per call. Folding inside the
    /// comparator would redo it for every comparison.
    private struct Candidate {
        let entry: CommandPaletteEntry
        let order: Int
        let title: String
        let rest: String
        var score = 0
    }

    static func results(
        _ entries: [CommandPaletteEntry],
        query: String,
        sessionLimit: Int = 40
    ) -> [CommandPaletteEntry] {
        let tokens = fold(query).split(separator: " ").map(String.init)
        var matched: [Candidate] = []
        for (order, entry) in entries.enumerated() {
            var candidate = Candidate(
                entry: entry,
                order: order,
                title: fold(entry.title),
                rest: fold(
                    ([entry.subtitle].compactMap { $0 } + entry.keywords)
                        .joined(separator: " ")
                )
            )
            var total = 0
            var matchedEveryToken = true
            for token in tokens {
                guard let score = score(token, in: candidate) else {
                    matchedEveryToken = false
                    break
                }
                total += score
            }
            guard matchedEveryToken else { continue }
            candidate.score = total
            matched.append(candidate)
        }

        matched.sort { left, right in
            if left.entry.kind != right.entry.kind {
                return left.entry.kind.rawValue < right.entry.kind.rawValue
            }
            if left.score != right.score { return left.score > right.score }
            if left.entry.kind == .session {
                let leftDate = left.entry.recency ?? .distantPast
                let rightDate = right.entry.recency ?? .distantPast
                if leftDate != rightDate { return leftDate > rightDate }
            }
            return left.order < right.order
        }

        var sessions = 0
        return matched.compactMap { candidate in
            guard candidate.entry.kind == .session else { return candidate.entry }
            sessions += 1
            return sessions <= sessionLimit ? candidate.entry : nil
        }
    }

    private static func score(_ token: String, in candidate: Candidate) -> Int? {
        if candidate.title.hasPrefix(token) { return 4 }
        if let range = candidate.title.range(of: token) {
            return startsWord(candidate.title, at: range.lowerBound) ? 3 : 2
        }
        if candidate.rest.contains(token) { return 1 }
        return nil
    }

    private static func startsWord(_ text: String, at index: String.Index) -> Bool {
        guard index > text.startIndex else { return true }
        let before = text[text.index(before: index)]
        return !before.isLetter && !before.isNumber
    }

    /// Lowercased, accent-insensitive, and with runs of whitespace collapsed,
    /// so "Café  Deploy" and "cafe deploy" are the same haystack.
    private static func fold(_ text: String) -> String {
        text
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}

#endif
