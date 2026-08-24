import Foundation

extension Notification.Name {
    static let os1OpenAutomationSettings = Notification.Name("os1.openAutomationSettings")
}

/// Automation ids inside agent output, linked to that automation's settings.
@MainActor
enum AutomationLinks {
    static let scheme = "os1automation"

    private static let uuidV7 =
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    private static let pattern = try! NSRegularExpression(
        pattern: "`(auto-\(uuidV7))`|(?<![\\w/-])(auto-\(uuidV7))",
        options: [.caseInsensitive]
    )
    private static var pendingSettingsId: String?

    static func automationId(from url: URL) -> String? {
        guard url.scheme == scheme else { return nil }
        let candidate = url.host ?? url.path
        let id = candidate.hasPrefix("/") ? String(candidate.dropFirst()) : candidate
        return id.range(of: "^auto-\(uuidV7)$", options: [.regularExpression, .caseInsensitive]) != nil
            ? id
            : nil
    }

    static func linkify(_ markdown: String) -> String {
        guard markdown.contains("auto-") else { return markdown }
        return MarkdownProse.rewrite(markdown) { line in
            line.contains("auto-") ? linkifyLine(line) : line
        }
    }

    static func chip(for id: String) -> TranscriptChip {
        TranscriptChip(
            kind: .automation,
            tone: .neutral,
            title: shortened(id),
            accessibilityLabel: "Open automation \(id)",
            destination: "\(scheme):\(id)"
        )
    }

    #if os(macOS)
    static func queueSettingsOpen(_ id: String) {
        pendingSettingsId = id
        NotificationCenter.default.post(name: .os1OpenAutomationSettings, object: id)
    }

    static func takePendingSettingsId() -> String? {
        defer { pendingSettingsId = nil }
        return pendingSettingsId
    }
    #endif

    private static func linkifyLine(_ line: String) -> String {
        let ns = line as NSString
        var result = ""
        var cursor = 0
        for match in pattern.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            let idRange = match.range(at: 1).location != NSNotFound
                ? match.range(at: 1)
                : match.range(at: 2)
            guard idRange.location != NSNotFound else { continue }
            let id = ns.substring(with: idRange)
            result += ns.substring(with: NSRange(
                location: cursor,
                length: match.range.location - cursor
            ))
            result += chip(for: id).markdown
            cursor = match.range.location + match.range.length
        }
        guard cursor > 0 else { return line }
        result += ns.substring(from: cursor)
        return result
    }

    private static func shortened(_ id: String) -> String {
        String(id.prefix(13)).replacingOccurrences(
            of: "-+$",
            with: "",
            options: .regularExpression
        ) + "…"
    }
}
