import Foundation

/// Plain (the support tool) as this app sees it: the Todo queue and one
/// thread's timeline, normalized server-side (src/agents/plain/api.ts) so no
/// client ever talks to Plain's GraphQL directly.
///
/// Everything here is customer data — real names, real email addresses, real
/// verbatim messages. It stays in memory for the screen that shows it and is
/// never written to disk, logged, or attached to a report.

/// One row of the Todo queue (`GET /api/plain/threads`).
struct SupportThreadSummary: Decodable, Identifiable, Hashable, Sendable {
    struct Customer: Decodable, Hashable, Sendable {
        let name: String?
        let email: String?
    }

    struct Assignee: Decodable, Hashable, Sendable {
        let id: String?
        let name: String?
        let isBot: Bool?
    }

    /// Queue rows spell the label's type `typeId`; the thread payload spells
    /// the same thing `labelTypeId`. Kept as separate types rather than one
    /// shared `Codable`, which would silently decode one of them as nil.
    struct Label: Decodable, Hashable, Sendable {
        let id: String
        let typeId: String?
        let name: String?
        let icon: String?
    }

    let id: String
    let title: String?
    let previewText: String?
    let status: String?
    let statusChangedAt: String?
    let createdAt: String?
    let priority: Int?
    let labels: [Label]?
    let customer: Customer?
    let assignee: Assignee?

    /// Plain's four priorities. Everything without one sits in Normal, which
    /// is what the web's lanes do.
    var lane: SupportPriority { SupportPriority(rawValue: priority ?? 2) ?? .normal }

    /// Who the row is about — the name if Plain has one, else the address.
    var customerLabel: String {
        customer?.name?.nilIfBlank ?? customer?.email?.nilIfBlank ?? "Unknown customer"
    }

    var displayTitle: String {
        title?.nilIfBlank ?? previewText?.nilIfBlank ?? "Untitled ticket"
    }

    /// What a compact queue row says: the ticket's subject, or the person if it
    /// has none. Matches the web sidebar's `t.title || customer` — the preview
    /// is a body, and a body in a one-line row reads as noise.
    var rowLabel: String {
        title?.nilIfBlank ?? customerLabel
    }
}

enum SupportPriority: Int, CaseIterable, Sendable {
    case urgent = 0, high = 1, normal = 2, low = 3

    var label: String {
        switch self {
        case .urgent: "Urgent"
        case .high: "High"
        case .normal: "Normal"
        case .low: "Low"
        }
    }
}

/// One thread's full timeline (`GET /api/plain/threads/:id`).
struct SupportThread: Decodable, Sendable {
    struct Customer: Decodable, Sendable {
        let id: String?
        let name: String?
        let email: String?
        let isSpam: Bool?
    }

    struct Assignee: Decodable, Sendable {
        let id: String?
        let name: String?
        let isBot: Bool?
    }

    struct Label: Decodable, Sendable {
        let id: String
        let labelTypeId: String?
        let name: String?
        let icon: String?
    }

    let id: String
    let title: String?
    /// Plain's own casing on the way out — "TODO" / "SNOOZED" / "DONE" — while
    /// writes take the lowercase form. Not a typo; the route validates the
    /// lowercase one and 400s on anything else.
    let status: String?
    let priority: Int?
    let customer: Customer?
    let assignee: Assignee?
    let labels: [Label]?
    let waitingSince: String?
    let awaitingFirstResponse: Bool?
    let entries: [SupportEntry]?

    var isDone: Bool { status?.uppercased() == "DONE" }
    var isSnoozed: Bool { status?.uppercased() == "SNOOZED" }

    var customerLabel: String {
        customer?.name?.nilIfBlank ?? customer?.email?.nilIfBlank ?? "Unknown customer"
    }
}

/// One timeline entry. The server drops everything that isn't someone
/// speaking — status changes, assignments and label edits never arrive — and
/// sorts what's left oldest-first.
struct SupportEntry: Decodable, Identifiable, Sendable {
    struct Attachment: Decodable, Identifiable, Sendable {
        let id: String
        let fileName: String?
        let mimeType: String?
        let sizeBytes: Int?

        var isImage: Bool { mimeType?.hasPrefix("image/") == true }

        /// Human size for the chip. Plain reports bytes.
        var sizeLabel: String? {
            guard let sizeBytes, sizeBytes > 0 else { return nil }
            return ByteCountFormatter.string(
                fromByteCount: Int64(sizeBytes),
                countStyle: .file
            )
        }
    }

    let id: String
    let timestamp: String?
    let actorName: String?
    /// "customer" | "support" | "bot" | "system".
    let actorType: String?
    /// "email" | "chat" | "note" | "message".
    let kind: String?
    let subject: String?
    let text: String
    let attachments: [Attachment]?

    /// Notes are the team talking to itself: a third kind, not a side. The
    /// customer never sees one.
    var isNote: Bool { kind == "note" }
    /// Inbound/outbound isn't a field — the web derives it from the actor, and
    /// so does this.
    var isFromCustomer: Bool { actorType == "customer" }

    var date: Date? { timestamp.flatMap(Session.parseISO) }
}

/// One file staged in the composer, before anything has been uploaded.
///
/// Held as bytes rather than a URL: a photo picked from the library has no
/// stable file to point at, and a security-scoped file from the Files app
/// stops being readable the moment the picker's callback returns. Pictures are
/// normalized through `AttachedImage` first — the same downscale-and-JPEG the
/// session composer applies — which is what keeps a modern phone screenshot
/// inside a reply's 6 MB budget.
struct SupportAttachmentDraft: Identifiable, Equatable, Sendable {
    /// Plain caps one file at 25 MB (routes/plain.ts), whatever the message
    /// mode is.
    static let maxFileBytes = 25 * 1024 * 1024
    /// The total a message may carry, which is where the two modes differ:
    /// Plain gives an internal note far more room than a customer reply.
    static let maxReplyBytes = 6 * 1024 * 1024
    static let maxNoteBytes = 50 * 1024 * 1024
    static let maxCount = 20

    let id: String
    let fileName: String
    let mimeType: String
    let data: Data

    var isImage: Bool { mimeType.hasPrefix("image/") }

    var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
    }

    init(id: String = UUID().uuidString, fileName: String, mimeType: String, data: Data) {
        self.id = id
        self.fileName = fileName
        self.mimeType = mimeType
        self.data = data
    }

    /// A picked picture, named for when it was taken: the photo library hands
    /// over bytes and no filename, and "attachment.jpg" in a customer's inbox
    /// says less than the date does.
    init(image: AttachedImage, takenAt: Date = Date()) {
        self.init(
            id: image.id,
            fileName: "Image \(Self.stamp(takenAt)).jpg",
            mimeType: image.mediaType,
            data: image.jpegData
        )
    }

    /// The limit that applies to a whole message in this mode.
    static func maxTotalBytes(isNote: Bool) -> Int {
        isNote ? maxNoteBytes : maxReplyBytes
    }

    /// `2026-08-13 at 14.05.22`, the shape macOS gives a screenshot.
    private static func stamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return formatter.string(from: date)
    }
}

/// A note's author and body, with the server's attribution prefix taken off.
///
/// Plain's API can't post as a workspace user, so a teammate's note goes out
/// under the machine user with `**Name (via Open Session):**` glued to the
/// front (routes/plain.ts). Showing that raw would put markup where a name
/// belongs, so the clients unpick it — the web with `NOTE_VIA_PREFIX`, this
/// with the same shape. The product name inside the prefix is matched loosely
/// because the server hardcodes it while the web writes its own.
enum SupportNote {
    static func unpick(_ text: String) -> (author: String?, body: String) {
        let pattern = #"^\*\*(.+?) \(via [^)]+\):\*\*\s*"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                  in: text,
                  range: NSRange(text.startIndex..., in: text)
              ),
              let nameRange = Range(match.range(at: 1), in: text),
              let fullRange = Range(match.range, in: text)
        else { return (nil, text) }
        return (String(text[nameRange]), String(text[fullRange.upperBound...]))
    }
}

extension String {
    /// Blank strings are as absent as nil here — Plain hands back empty names
    /// and empty titles rather than omitting them.
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
