import Foundation

struct ActiveSessionSummary: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let repo: String
    let startedAt: Double?
}

struct ActiveSessionsSnapshot: Codable, Hashable, Sendable {
    static let maximumVisibleSessions = 3

    let sessions: [ActiveSessionSummary]
    let totalCount: Int
    let unreadCount: Int
    let updatedAt: Double

    static let empty = ActiveSessionsSnapshot(
        sessions: [], totalCount: 0, unreadCount: 0,
        updatedAt: Date().timeIntervalSince1970
    )

    init(
        sessions: [ActiveSessionSummary],
        totalCount: Int,
        unreadCount: Int = 0,
        updatedAt: Double
    ) {
        self.sessions = sessions
        self.totalCount = totalCount
        self.unreadCount = unreadCount
        self.updatedAt = updatedAt
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try container.decode([ActiveSessionSummary].self, forKey: .sessions)
        totalCount = try container.decode(Int.self, forKey: .totalCount)
        unreadCount = try container.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        updatedAt = try container.decode(Double.self, forKey: .updatedAt)
    }
}

#if os(iOS)
import ActivityKit

struct ActiveSessionsAttributes: ActivityAttributes {
    typealias ContentState = ActiveSessionsSnapshot

    let deviceId: String
}
#endif
