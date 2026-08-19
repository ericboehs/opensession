import Foundation

/// Git commits named in transcript prose, turned into code-shaped links.
///
/// These rules mirror the web's commit reference extension
/// (`src/frontend/lib/markdown.ts`). A hexadecimal run is too weak a signal on
/// its own, so it only links when it is an exact code span, follows
/// `commit`/`commits`/`sha`, or is a bare GitHub commit URL for a configured
/// repository. The abbreviated form is 7–12 characters; a full SHA is 40.
/// Abbreviations made only of digits stay plain because they are usually build
/// numbers or timestamps rather than commits.
///
/// The link uses a private scheme. Following it first asks `/api/commit`, which
/// can correct the repo hint when prose crosses repositories and can describe
/// commits that have not reached GitHub yet.
@MainActor
enum CommitLinks {
    static let scheme = "os1commit"

    struct Reference: Equatable, Identifiable {
        let repo: String
        let sha: String

        var id: String { "\(repo)@\(sha)" }
        var shortSha: String { String(sha.prefix(8)) }
    }

    private static var repos: [String: String?] = [:]

    static func register(repos next: [String: String?]) {
        guard next != repos else { return }
        repos = next
        TranscriptLinks.shared.invalidate()
    }

    static func reference(from url: URL) -> Reference? {
        guard url.scheme == scheme else { return nil }
        let candidate = url.host.map { $0 + url.path } ?? url.path
        let trimmed = candidate.hasPrefix("/") ? String(candidate.dropFirst()) : candidate
        let parts = trimmed.split(separator: "/")
        guard parts.count == 2 else { return nil }
        let repo = String(parts[0]).removingPercentEncoding ?? String(parts[0])
        let sha = String(parts[1]).lowercased()
        guard lookupSha.matches(sha) else { return nil }
        return Reference(repo: repo, sha: sha)
    }

    static func linkify(_ markdown: String, repo: String?) -> String {
        guard markdown.contains("`")
                || markdown.localizedCaseInsensitiveContains("commit")
                || markdown.localizedCaseInsensitiveContains("sha")
                || markdown.localizedCaseInsensitiveContains("github.com")
        else { return markdown }
        return MarkdownProse.rewrite(markdown) { rewrite(line: $0, repo: repo) }
    }

    private static let shaSource = "(?:[0-9a-f]{7,12}|[0-9a-f]{40})"
    private static let githubURLSource =
        "https?://(?:www\\.)?github\\.com/[\\w.-]+/[\\w.-]+/commit/[0-9a-f]{7,40}/?"

    /// Exact SHA code spans come before the general code-span skip. This lets
    /// `` `4ed1ef09` `` link while `git show 4ed1ef09` stays byte-for-byte code.
    private static let pattern = try! NSRegularExpression(
        pattern:
            "(?<![\\w`-])`(?<coded>\(shaSource))`"
            + "|(?<skip>`{2,}[^\\r\\n]*?`{2,}|`[^`]*`|!?\\[[^\\]]*\\]\\([^)]*\\))"
            + "|(?<angle><\(githubURLSource)>)"
            + "|(?<url>\(githubURLSource))(?![\\w/?#-]|\\.(?=[\\w-]))"
            + "|(?<![\\w`-])(?<cue>(?:commits?|sha)[ \\t]+)"
            + "(?<cued>\(shaSource))(?![\\w-])",
        options: [.caseInsensitive]
    )

    private static let lookupSha = try! NSRegularExpression(
        pattern: "^[0-9a-f]{7,40}$",
        options: [.caseInsensitive]
    )

    private static func rewrite(line: String, repo: String?) -> String {
        let ns = line as NSString
        var result = ""
        var cursor = 0
        for match in pattern.matches(
            in: line,
            range: NSRange(location: 0, length: ns.length)
        ) {
            let replacement: String?
            if match.range(withName: "skip").location != NSNotFound {
                replacement = bareGithubLink(
                    ns.substring(with: match.range(withName: "skip"))
                ).map { link(label: $0.shortSha, reference: $0) }
            } else if match.range(withName: "coded").location != NSNotFound {
                let sha = ns.substring(with: match.range(withName: "coded"))
                replacement = repo.flatMap { repo in commitShaped(sha)
                    ? link(
                        label: sha.lowercased(),
                        reference: Reference(repo: repo, sha: sha.lowercased())
                    )
                    : nil }
            } else if match.range(withName: "cued").location != NSNotFound {
                let sha = ns.substring(with: match.range(withName: "cued"))
                let cue = ns.substring(with: match.range(withName: "cue"))
                replacement = repo.flatMap { repo in commitShaped(sha)
                    ? cue + link(
                        label: sha.lowercased(),
                        reference: Reference(repo: repo, sha: sha.lowercased())
                    )
                    : nil }
            } else {
                let range = match.range(withName: "angle").location != NSNotFound
                    ? match.range(withName: "angle")
                    : match.range(withName: "url")
                let written = ns.substring(with: range)
                let raw = written.hasPrefix("<") ? String(written.dropFirst().dropLast()) : written
                replacement = githubReference(raw).map {
                    link(label: $0.shortSha, reference: $0)
                }
            }

            guard let replacement else { continue }
            result += ns.substring(with: NSRange(
                location: cursor,
                length: match.range.location - cursor
            ))
            result += replacement
            cursor = match.range.location + match.range.length
        }
        guard cursor > 0 else { return line }
        result += ns.substring(from: cursor)
        return result
    }

    private static func commitShaped(_ sha: String) -> Bool {
        sha.count == 40 || sha.rangeOfCharacter(from: CharacterSet(charactersIn: "abcdefABCDEF")) != nil
    }

    private static func githubReference(_ raw: String) -> Reference? {
        guard let components = URLComponents(string: raw),
              ["github.com", "www.github.com"].contains(components.host?.lowercased() ?? ""),
              components.query == nil,
              components.fragment == nil
        else { return nil }
        let parts = components.path.split(separator: "/")
        guard parts.count == 4,
              parts[2].lowercased() == "commit"
        else { return nil }
        let target = "\(parts[0])/\(parts[1])".lowercased()
        guard let repo = repos.first(where: { $0.value?.lowercased() == target })?.key else {
            return nil
        }
        let sha = String(parts[3]).lowercased()
        guard lookupSha.matches(sha) else { return nil }
        return Reference(repo: repo, sha: sha)
    }

    /// Marked treats `[URL](URL)` like the bare URL it auto-linked, so the web
    /// turns it into a commit reference too. A human label remains their prose
    /// and keeps its explicit destination.
    private static func bareGithubLink(_ markdown: String) -> Reference? {
        guard markdown.hasPrefix("["), !markdown.hasPrefix("!["),
              let split = markdown.range(of: "]("), markdown.hasSuffix(")")
        else { return nil }
        let label = String(markdown[markdown.index(after: markdown.startIndex)..<split.lowerBound])
        let destination = String(markdown[split.upperBound..<markdown.index(before: markdown.endIndex)])
        guard label == destination else { return nil }
        return githubReference(destination)
    }

    private static func link(label: String, reference: Reference) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "._-~")
        let repo = reference.repo.addingPercentEncoding(withAllowedCharacters: allowed)
            ?? reference.repo
        // Inline code inside the link keeps the SHA in the code treatment it
        // was written in while still giving the text renderer a destination.
        return "[`\(label)`](\(scheme):\(repo)/\(reference.sha))"
    }
}

private extension NSRegularExpression {
    func matches(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return firstMatch(in: value, range: range)?.range == range
    }
}
