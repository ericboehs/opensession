import Foundation

/// One commit from `GET /api/commit`, resolved against the server's checkouts.
struct CommitDetails: Decodable, Equatable, Sendable {
    let repo: String
    let sha: String
    let shortSha: String
    let title: String
    let body: String?
    let author: String
    let person: String?
    let committedAt: String
    let filesChanged: Int
    let additions: Int
    let deletions: Int
    let url: String?
    let onDefaultBranch: Bool
    let defaultBranch: String

    var committedDate: Date? { Session.parseISO(committedAt) }

    static func lookupPath(sha: String, repo: String?) -> String {
        var components = URLComponents()
        components.path = "/api/commit"
        components.queryItems = [URLQueryItem(name: "sha", value: sha)]
        if let repo, !repo.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "repo", value: repo))
        }
        return components.string ?? "/api/commit"
    }
}
