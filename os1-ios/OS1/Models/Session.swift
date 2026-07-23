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

    /// The web sidebar's status lanes (Sidebar.tsx MINE_STATUS_META), in its
    /// display order, derived from the same signals we have: waiting beats
    /// running beats PR state; everything else is backlog.
    enum Lane: String, CaseIterable {
        case needsInput, inProgress, inReview, done, backlog

        var label: String {
            switch self {
            case .needsInput: "Needs input"
            case .inProgress: "In progress"
            case .inReview: "In review"
            case .done: "Done"
            case .backlog: "Backlog"
            }
        }
    }

    var lane: Lane {
        if waitingForInput == true { return .needsInput }
        if isRunning == true { return .inProgress }
        if prState == "OPEN" { return .inReview }
        if prState == "MERGED" { return .done }
        return .backlog
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
