import Foundation

/// Open Session's own review request on a session: who was asked, by whom, and
/// whether they have signed off. GitHub's reviewer list is a separate fact
/// (`Session.prReviewRequested`) — see `Session.reviewRequest`.
struct SessionReviewRequest: Decodable, Equatable, Hashable {
    /// The reviewer's display name, or a review team's GitHub spec.
    var to: String
    /// The individual people a team request covers, expanded server-side.
    var recipients: [String]?
    /// Who asked.
    var by: String
    /// ISO timestamp of the ask.
    var at: String
    /// Set when the reviewer signs off. The request stays in place so the
    /// asker still sees who reviewed it.
    var accepted: Signoff?

    struct Signoff: Decodable, Equatable, Hashable {
        var by: String
        var at: String
    }

    /// Is this request pointed at `person` (the reviewer, or anyone in the
    /// team it was made to)?
    func targets(_ person: String) -> Bool {
        let key = person.trimmingCharacters(in: .whitespaces).lowercased()
        guard !key.isEmpty else { return false }
        return ([to] + (recipients ?? [])).contains { $0.lowercased() == key }
    }
}

/// Where a workspace's review stands, for both of the people who can give one:
/// the agent that reads the pull request, and the teammate somebody asked.
///
/// A workspace is the unit here, not a session. The request is stored per
/// session but the sidebar's Needs-review band groups by workspace, so a
/// request set on a sibling session has to reach the panel of the one you have
/// open — carrying the id it actually lives on, so clearing or re-assigning
/// writes to the right session. Same rule as the web's `effectiveReview`
/// (components/SessionViewer.tsx).
enum WorkspaceReview {
    struct State: Equatable {
        /// The workspace's request, with a GitHub-completed sign-off folded in.
        var request: SessionReviewRequest?
        /// The session that owns it — where a change is written.
        var ownerId: String
        /// The sign-off came from GitHub rather than from the menu, so
        /// reopening means asking again rather than clearing a local flag.
        var acceptedFromPr: Bool
        /// Everyone GitHub still lists as a requested reviewer, across every
        /// PR in the workspace.
        var githubRequested: [String]
    }

    static func state(
        of sessions: [Session],
        openSessionId: String
    ) -> State {
        let open = sessions.first { $0.id == openSessionId }
        let owner = (open?.reviewRequest != nil ? open : nil)
            ?? sessions.first { $0.reviewRequest != nil }
        let request = owner?.reviewRequest
        let signoff = owner.flatMap { session in
            request.flatMap { completion(of: $0, on: session) }
        }
        var withSignoff = request
        if let signoff { withSignoff?.accepted = signoff }
        // A workspace can span several pull requests, and a request on any of
        // them is a request on the workspace.
        var seen = Set<String>()
        let requested = sessions
            .flatMap { $0.prReviewRequested ?? [] }
            .filter { seen.insert($0.lowercased()).inserted }
        return State(
            request: withSignoff,
            ownerId: owner?.id ?? openSessionId,
            acceptedFromPr: signoff != nil,
            githubRequested: requested
        )
    }

    /// A review the reviewer gave on GitHub instead of pressing "Mark as
    /// reviewed" here. GitHub drops somebody from the requested list the
    /// moment they submit, so "reviewed, and no longer pending" is the test —
    /// and it only counts when it happened after the ask.
    static func completion(
        of request: SessionReviewRequest,
        on session: Session
    ) -> SessionReviewRequest.Signoff? {
        guard request.accepted == nil, let updatedAt = session.prUpdatedAt else { return nil }
        guard let reviewedAt = Session.parseISO(updatedAt),
              let requestedAt = Session.parseISO(request.at),
              reviewedAt > requestedAt
        else { return nil }
        let reviewers = [request.to] + (request.recipients ?? [])
        let reviewed = (session.prReviewedBy ?? []).map { $0.lowercased() }
        let pending = (session.prReviewRequested ?? []).map { $0.lowercased() }
        guard let reviewer = reviewers.first(where: { person in
            let key = person.lowercased()
            return reviewed.contains(key) && !pending.contains(key)
        }) else { return nil }
        return SessionReviewRequest.Signoff(by: reviewer, at: updatedAt)
    }
}
