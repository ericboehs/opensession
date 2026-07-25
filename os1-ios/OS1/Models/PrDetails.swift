import Foundation

/// PR details from `GET /api/sessions/:id/pr` — a tolerant subset of the
/// server's PrDetails (src/server/pr-info.ts). The route answers a bare JSON
/// `null` when the session's branch has no PR; decoding is optional-heavy so
/// server-side additions never break the client.
struct PrDetails: Decodable, Equatable {
    var number: Int
    var title: String?
    var url: String?
    /// OPEN | MERGED | CLOSED
    var state: String?
    var isDraft: Bool?
    var baseRefName: String?
    var headRefName: String?
    var additions: Int?
    var deletions: Int?
    var changedFiles: Int?
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
    var reviewDecision: String?
    var author: String?
    var checks: [PrCheck]?
    var reviewers: [PrReviewer]?
    /// MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe.
    var mergeable: String?
    /// CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | … — merge-box state.
    var mergeStateStatus: String?
}

struct PrCheck: Decodable, Equatable {
    var name: String
    /// COMPLETED, IN_PROGRESS, QUEUED… ("" for StatusContexts).
    var status: String?
    /// SUCCESS, FAILURE, NEUTRAL, PENDING…
    var conclusion: String?
    var url: String?
    var startedAt: String?
    var completedAt: String?
    /// CheckRun workflow (e.g. "CI") — StatusContexts (Vercel deploys) have none.
    var workflowName: String?

    enum Rank {
        case success, failure, pending, neutral
    }

    /// Mirrors the web PrPanel's checkClass(): anything not completed is
    /// pending, and StatusContexts report PENDING/EXPECTED as a *conclusion*
    /// with an empty status, which must not read as neutral.
    var rank: Rank {
        let liveStatus = status ?? ""
        if liveStatus != "COMPLETED" && liveStatus != "" { return .pending }
        switch conclusion ?? "" {
        case "PENDING", "EXPECTED": return .pending
        case "SUCCESS": return .success
        case "FAILURE", "TIMED_OUT", "ERROR": return .failure
        default: return .neutral
        }
    }
}

/// A person on the PR's reviewer list; `state` is the review outcome
/// (APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED) or PENDING for a
/// requested-but-not-yet-submitted review.
struct PrReviewer: Decodable, Equatable {
    var login: String
    var state: String?
    var isTeam: Bool?
}

extension PrDetails {
    /// One-dot summary for the toolbar chip: terminal states first, then the
    /// check rollup while open (no checks at all counts as passing — "no
    /// known CI blocker", matching the web list's treatment).
    enum Summary {
        case merged, closed, draft, failing, pending, passing
    }

    var summary: Summary {
        switch state ?? "" {
        case "MERGED": return .merged
        case "CLOSED": return .closed
        default: break
        }
        if isDraft == true { return .draft }
        let ranks = (checks ?? []).map(\.rank)
        if ranks.contains(.failure) { return .failing }
        if ranks.contains(.pending) { return .pending }
        return .passing
    }
}
