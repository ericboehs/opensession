import Foundation

/// Wire shapes for the sidebar tools this app draws as lists: Tasks and Feed.
/// They are hand-written copies of the server's types, the same as every other
/// model here, so a server change does not reach them on its own. Their
/// sources, in order:
///
/// - `TodoItem` mirrors `TodoItem` in packages/core/opensession-server/src/server/todos.ts
/// - `RecentPr` / `RecentCommit` mirror packages/core/opensession-server/src/frontend/lib/api/prs.ts
///
/// Unknown fields decode away, so a field added on the server is additive
/// until someone needs it here.

// MARK: - Tasks

enum TodoStatus: String, Codable, Sendable {
    case open
    case done
    case dropped
}

struct TodoSource: Codable, Hashable, Sendable {
    /// "session" when an agent added it, "manual" when a person did.
    let kind: String?
    /// The session that added it, when there is one to open.
    let sessionId: String?
    /// Who was driving, for display.
    let by: String?
}

struct TodoItem: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let user: String
    let text: String
    let status: TodoStatus
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    /// Provenance line the web shows under the title.
    let note: String?
    /// ISO date, YYYY-MM-DD.
    let due: String?
    /// ISO datetime. The server pushes and Slack-DMs once it passes.
    let remindAt: String?
    /// Set once the reminder fired, so it fires exactly once.
    let remindedAt: String?
    let source: TodoSource

    var isDone: Bool { status == .done }
}

struct TodoListResponse: Codable, Sendable {
    let todos: [TodoItem]
}

struct TodoResponse: Codable, Sendable {
    let todo: TodoItem
}

// MARK: - Feed

/// A recent pull request: an open one, plus how it ended and how big it was.
struct RecentPr: Codable, Identifiable, Hashable, Sendable {
    let repo: String
    let branch: String
    let url: String
    let number: Int
    let title: String
    let author: String
    let person: String?
    let updatedAt: String
    /// "OPEN", "MERGED" or "CLOSED".
    let state: String
    let additions: Int?
    let deletions: Int?

    var id: String { "\(repo)#\(number)" }
    var isMerged: Bool { state == "MERGED" }
}

struct RecentPrsResponse: Codable, Sendable {
    let prs: [RecentPr]
}

/// One commit on the default branch of a repo that ships without pull
/// requests. Open Session's own repo is the reason this exists.
struct RecentCommit: Codable, Identifiable, Hashable, Sendable {
    let repo: String
    let sha: String
    let title: String
    let url: String?
    let author: String
    let person: String?
    let committedAt: String
    let additions: Int?
    let deletions: Int?
    /// The session that wrote it, when the server can name one.
    let sessionId: String?

    var id: String { "\(repo):\(sha)" }
    var shortSha: String { String(sha.prefix(7)) }
}

/// One page of the commit feed: the window served, and whether older history
/// is left to ask for.
struct RecentCommitPage: Codable, Sendable {
    let commits: [RecentCommit]
    let days: Int?
    let hasMore: Bool?
}

// MARK: - The feed row

/// One shipped thing.
///
/// Not every repo ships the same way: most land work as a merged pull request,
/// while a shared-checkout repo commits straight to its default branch and has
/// no pull request to show. Both become this, so the page answers "what
/// shipped" rather than "what merged". Same idea as the web's `feed-rows.ts`.
struct FeedRow: Identifiable, Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        case pullRequest
        case commit
    }

    let id: String
    let kind: Kind
    let title: String
    let repo: String
    /// What to call it in the list: "#128" for a pull request, a short sha for
    /// a commit.
    let ref: String
    /// Who shipped it. A teammate's name, or the automation's own.
    let owner: String?
    let url: String?
    let additions: Int?
    let deletions: Int?
    let shippedAt: Date?
    /// The session behind it, when there is one to open. An id rather than the
    /// session, because most of these are archived by the time they ship and
    /// holding the object would drop the row.
    let sessionId: String?
}

enum FeedRows {
    /// Merged pull requests and commits in one list, newest first.
    ///
    /// Only merged pull requests are here. An open one is work in flight, and
    /// the Pull requests tool is where you go to read those.
    static func build(prs: [RecentPr], commits: [RecentCommit]) -> [FeedRow] {
        let prRows = prs.filter(\.isMerged).map { pr in
            FeedRow(
                id: "pr:\(pr.id)",
                kind: .pullRequest,
                title: pr.title,
                repo: pr.repo,
                ref: "#\(pr.number)",
                owner: owner(person: pr.person, author: pr.author),
                url: pr.url,
                additions: pr.additions,
                deletions: pr.deletions,
                shippedAt: Session.parseISO(pr.updatedAt),
                sessionId: nil
            )
        }
        let commitRows = commits.map { commit in
            FeedRow(
                id: "commit:\(commit.id)",
                kind: .commit,
                title: commit.title,
                repo: commit.repo,
                ref: commit.shortSha,
                owner: owner(person: commit.person, author: commit.author),
                url: commit.url,
                additions: commit.additions,
                deletions: commit.deletions,
                shippedAt: Session.parseISO(commit.committedAt),
                sessionId: commit.sessionId
            )
        }
        return (prRows + commitRows).sorted {
            ($0.shippedAt ?? .distantPast) > ($1.shippedAt ?? .distantPast)
        }
    }

    /// A row's owner is whoever owns the session behind it, which is not
    /// always a teammate: an automation owns its own sessions, so the field
    /// carries the automation's name. Either way its name is the best label it
    /// has. Nil only when nothing was recorded, which is how work from before
    /// commits carried a name still reads.
    private static func owner(person: String?, author: String?) -> String? {
        if let person, !person.isEmpty { return person }
        let author = (author ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return author.isEmpty ? nil : author
    }
}

// The dates these rows carry are parsed once, when the rows are built, with
// `Session.parseISO`: it caches by the immutable wire string, and the reason
// it exists is that timestamp parsing inside a SwiftUI body once spent a whole
// watchdog allowance in ICU. Never parse one in a view body.
