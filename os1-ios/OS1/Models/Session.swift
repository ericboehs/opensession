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
    var effort: String?
    var fastMode: Bool?
    var isRunning: Bool?
    var runState: String?
    /// Journaled start of the current run — only present while running.
    var runStartedAt: String?
    var waitingForInput: Bool?
    var queuedCount: Int?
    var archived: Bool?
    var desk: Bool?
    var createdAt: String?
    var lastActivity: String?
    var prUrl: String?
    var prState: String?
    var prNumber: Int?
    var startedBy: String?
    var automation: AutomationFlag?

    /// True for automation-owned sessions (triage runs, scheduled jobs) —
    /// the bulk of server noise a person's list should hide by default.
    var isAutomation: Bool {
        automation?.isAutomation ?? (startedBy?.hasSuffix("(automation)") ?? false)
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return id
    }

    var lastActivityDate: Date? {
        Self.parseISO(lastActivity)
    }

    var runStartedDate: Date? {
        Self.parseISO(runStartedAt)
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

    /// Status lanes in native display order. Running sessions stay above all
    /// other work; within a session, waiting still takes precedence over running.
    enum Lane: String, CaseIterable {
        case inProgress, needsInput, inReview, done, backlog

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

extension Session {
    /// Locally-built placeholder for a session the server just created but
    /// hasn't persisted to the list yet — rendered (and opened) immediately
    /// instead of polling until `GET /api/sessions` includes it.
    static func optimistic(
        id: String,
        title: String,
        repo: String,
        mode: String,
        model: String?,
        effort: String?,
        fastMode: Bool,
        startedBy: String
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.source = "backstage"
        session.repo = repo
        session.mode = mode
        session.model = model
        session.effort = effort
        session.fastMode = fastMode ? true : nil
        session.isRunning = true
        session.runStartedAt = ISO8601DateFormatter().string(from: .now)
        session.createdAt = session.runStartedAt
        session.lastActivity = session.runStartedAt
        session.startedBy = startedBy
        return session
    }

    /// Bare session with just an id; every other field starts nil.
    init(id: String) {
        self.id = id
    }
}

/// The server's `automation` field is `true` OR the automation's name —
/// either way it means "not a person's chat". Tolerant of both shapes.
struct AutomationFlag: Decodable, Equatable, Hashable {
    let isAutomation: Bool

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let flag = try? container.decode(Bool.self) {
            isAutomation = flag
        } else if let name = try? container.decode(String.self) {
            isAutomation = !name.isEmpty
        } else {
            isAutomation = false
        }
    }
}
