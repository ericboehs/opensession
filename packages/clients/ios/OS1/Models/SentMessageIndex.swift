import Foundation

/// One message the current person can jump back to from the transcript rail.
struct SentMessageAnchor: Identifiable, Equatable {
    let id: String
    let preview: String
    let timestamp: Date?
}

/// Builds the compact index behind the native sent-message navigation rail.
enum SentMessageIndex {
    static func collect(
        from entries: [TranscriptEntry],
        owner: String?,
        viewerName: String,
        viewerLogin: String
    ) -> [SentMessageAnchor] {
        entries.compactMap { entry in
            guard entry.isUser,
                  entry.notice == nil,
                  MessageAttribution.isViewerMessage(
                      sender: entry.sender,
                      owner: owner,
                      viewerName: viewerName,
                      viewerLogin: viewerLogin
                  ),
                  let preview = preview(for: entry)
            else { return nil }
            return SentMessageAnchor(
                id: entry.id,
                preview: preview,
                timestamp: entry.timestampDate
            )
        }
    }

    private static func preview(for entry: TranscriptEntry) -> String? {
        let text = dropLeadingQuote(entry.text)
            .split(whereSeparator: \Character.isWhitespace)
            .joined(separator: " ")
        if !text.isEmpty { return clamp(text, to: 120) }
        let imageCount = entry.images?.count ?? 0
        guard imageCount > 0 else { return nil }
        return imageCount == 1 ? "Image" : "\(imageCount) images"
    }

    /// A quoted transcript selection leads the message. The index names what
    /// the person added, not the text they were replying to.
    private static func dropLeadingQuote(_ text: String) -> String {
        let lines = text.components(separatedBy: .newlines)
        var index = 0
        while index < lines.count {
            let line = lines[index].trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix(">") { index += 1 }
            else { break }
        }
        let remainder = lines[index...].joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return remainder.isEmpty ? text : remainder
    }

    private static func clamp(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        let end = text.index(text.startIndex, offsetBy: limit)
        let prefix = text[..<end]
        let minimum = text.index(text.startIndex, offsetBy: limit * 3 / 5)
        let breakAt = prefix.lastIndex(of: " ")
        let clamped: Substring
        if let breakAt, breakAt >= minimum {
            clamped = prefix[..<breakAt]
        } else {
            clamped = prefix
        }
        return clamped.trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}
