import Foundation

/// One row from `GET /api/sessions` — a subset of the server's UnifiedSession.
/// Decoding is deliberately tolerant: almost everything is optional and unknown
/// fields are ignored, so server-side additions never break the client.
struct Session: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    var title: String?
    var source: String?
    var repo: String?
    var branch: String?
    var mode: String?
    var model: String?
    var isRunning: Bool?
    var runState: String?
    var waitingForInput: Bool?
    var queuedCount: Int?
    var archived: Bool?
    var createdAt: String?
    var lastActivity: String?
    var prUrl: String?
    var prState: String?

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return id
    }

    var lastActivityDate: Date? {
        Self.parseISO(lastActivity)
    }

    enum Status {
        case needsInput
        case running
        case idle
    }

    var status: Status {
        if waitingForInput == true { return .needsInput }
        if isRunning == true { return .running }
        return .idle
    }

    static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}
