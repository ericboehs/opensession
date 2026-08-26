import Foundation

/// GitHub user attachments inside pull-request prose. Their stable GitHub URL
/// needs browser-cookie auth, so native review surfaces point it at this
/// instance's `/gh-asset` resolver instead. Bare attachment URLs are the form
/// GitHub uses for inline videos; they become their own render block while
/// images and labelled links stay markdown.
enum PrMarkdownMedia {
    enum Block: Equatable {
        case markdown(String)
        case video(URL)
    }

    private struct Fence {
        let marker: Character
        let length: Int
    }

    private static let uuidPattern =
        #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#
    private static let uuid = try! NSRegularExpression(
        pattern: "^(?:\(uuidPattern))$",
        options: .caseInsensitive
    )
    private static let uuidInPath = try! NSRegularExpression(
        pattern: uuidPattern,
        options: .caseInsensitive
    )
    private static let attachmentURLPattern =
        #"https://(?:github\.com/user-attachments/assets/[0-9a-f-]{36}|private-user-images\.githubusercontent\.com/[^\s<>"')\]]+)"#
    private static let lineToken = try! NSRegularExpression(
        pattern: "(`[^`]*`)|(\(attachmentURLPattern))",
        options: .caseInsensitive
    )

    static func blocks(
        in markdown: String,
        repo: String?,
        baseURL: URL?
    ) -> [Block] {
        guard let repo, !repo.isEmpty, let baseURL else {
            return [.markdown(markdown)]
        }

        var blocks: [Block] = []
        var pending: [String] = []
        var fence: Fence?

        func flushMarkdown() {
            guard !pending.isEmpty else { return }
            blocks.append(.markdown(pending.joined(separator: "\n")))
            pending.removeAll(keepingCapacity: true)
        }

        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let value = String(line)
            let trimmed = value.trimmingCharacters(in: .whitespaces)

            if let open = fence {
                pending.append(value)
                if closesFence(value, open: open) { fence = nil }
                continue
            }
            if let opening = openingFence(in: value) {
                pending.append(value)
                fence = opening
                continue
            }

            if !value.hasPrefix("    "),
               !value.hasPrefix("\t"),
               let source = bareURL(in: trimmed),
               let video = proxyURL(for: source, repo: repo, baseURL: baseURL)
            {
                flushMarkdown()
                blocks.append(.video(video))
            } else {
                pending.append(
                    value.hasPrefix("    ") || value.hasPrefix("\t")
                        ? value
                        : rewriteLine(value, repo: repo, baseURL: baseURL)
                )
            }
        }
        flushMarkdown()
        return blocks.isEmpty ? [.markdown("")] : blocks
    }

    static func rewrite(
        _ markdown: String,
        repo: String?,
        baseURL: URL?
    ) -> String {
        guard let repo, !repo.isEmpty, let baseURL else { return markdown }
        var out: [String] = []
        var fence: Fence?
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let value = String(line)
            if let open = fence {
                out.append(value)
                if closesFence(value, open: open) { fence = nil }
            } else if let opening = openingFence(in: value) {
                out.append(value)
                fence = opening
            } else {
                out.append(
                    value.hasPrefix("    ") || value.hasPrefix("\t")
                        ? value
                        : rewriteLine(value, repo: repo, baseURL: baseURL)
                )
            }
        }
        return out.joined(separator: "\n")
    }

    static func proxyURL(for source: String, repo: String, baseURL: URL) -> URL? {
        guard !repo.isEmpty, let id = attachmentID(from: source) else { return nil }
        guard var components = URLComponents(
            url: baseURL
                .appendingPathComponent("gh-asset")
                .appendingPathComponent(id),
            resolvingAgainstBaseURL: false
        ) else { return nil }
        components.queryItems = [URLQueryItem(name: "repo", value: repo)]
        return components.url
    }

    private static func rewriteLine(_ line: String, repo: String, baseURL: URL) -> String {
        let ns = line as NSString
        var result = ""
        var cursor = 0
        for match in lineToken.matches(
            in: line,
            range: NSRange(location: 0, length: ns.length)
        ) {
            let sourceRange = match.range(at: 2)
            // Group 1 is inline code, copied as part of the text before the
            // next attachment rather than rewritten.
            guard sourceRange.location != NSNotFound else { continue }
            let source = ns.substring(with: sourceRange)
            guard let proxy = proxyURL(for: source, repo: repo, baseURL: baseURL) else {
                continue
            }
            result += ns.substring(with: NSRange(
                location: cursor,
                length: sourceRange.location - cursor
            ))
            result += proxy.absoluteString
            cursor = sourceRange.location + sourceRange.length
        }
        guard cursor > 0 else { return line }
        result += ns.substring(from: cursor)
        return result
    }

    private static func bareURL(in line: String) -> String? {
        let candidate: String
        if line.hasPrefix("<"), line.hasSuffix(">") {
            candidate = String(line.dropFirst().dropLast())
        } else {
            candidate = line
        }
        return attachmentID(from: candidate) == nil ? nil : candidate
    }

    private static func attachmentID(from source: String) -> String? {
        guard let url = URL(string: source), let host = url.host?.lowercased() else {
            return nil
        }

        if host == "github.com" {
            let parts = url.pathComponents.filter { $0 != "/" }
            guard parts.count == 3,
                  parts[0] == "user-attachments",
                  parts[1] == "assets",
                  isUUID(parts[2])
            else { return nil }
            return parts[2].lowercased()
        }

        guard host == "private-user-images.githubusercontent.com" else { return nil }
        let path = url.path
        let range = NSRange(path.startIndex..., in: path)
        guard let match = uuidInPath.firstMatch(in: path, range: range),
              let idRange = Range(match.range, in: path)
        else { return nil }
        return path[idRange].lowercased()
    }

    private static func isUUID(_ value: String) -> Bool {
        uuid.firstMatch(
            in: value,
            range: NSRange(value.startIndex..., in: value)
        ) != nil
    }

    private static func openingFence(in line: String) -> Fence? {
        let spaces = line.prefix { $0 == " " }.count
        guard spaces <= 3, !line.hasPrefix("\t") else { return nil }
        let body = line.dropFirst(spaces)
        guard let marker = body.first, marker == "`" || marker == "~" else {
            return nil
        }
        let length = body.prefix { $0 == marker }.count
        return length >= 3 ? Fence(marker: marker, length: length) : nil
    }

    private static func closesFence(_ line: String, open: Fence) -> Bool {
        let spaces = line.prefix { $0 == " " }.count
        guard spaces <= 3, !line.hasPrefix("\t") else { return false }
        let body = line.dropFirst(spaces)
        let length = body.prefix { $0 == open.marker }.count
        guard length >= open.length else { return false }
        return body.dropFirst(length).allSatisfy { $0 == " " || $0 == "\t" }
    }
}
