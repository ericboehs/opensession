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
    let updatedAt: Double

    static let empty = ActiveSessionsSnapshot(
        sessions: [], totalCount: 0, updatedAt: Date().timeIntervalSince1970
    )

}

#if os(iOS)
import ActivityKit

struct ActiveSessionsAttributes: ActivityAttributes {
    typealias ContentState = ActiveSessionsSnapshot

    let deviceId: String
}
#endif
