import Foundation
import Testing
@testable import OS1

/// Where a workspace's review request lives, and when it counts as given.
///
/// Both rules are shared with the web (`effectiveReview` in SessionViewer.tsx,
/// `prReviewCompletion` in lib/review-queue): a request set on one session
/// speaks for the whole workspace, and a review submitted on GitHub completes
/// it without anybody pressing anything here.
struct WorkspaceReviewTests {
    private func session(
        id: String,
        request: SessionReviewRequest? = nil,
        requested: [String]? = nil,
        reviewedBy: [String]? = nil,
        prUpdatedAt: String? = nil
    ) -> Session {
        var session = Session(id: id)
        session.reviewRequest = request
        session.prReviewRequested = requested
        session.prReviewedBy = reviewedBy
        session.prUpdatedAt = prUpdatedAt
        return session
    }

    private func request(
        to: String,
        recipients: [String]? = nil,
        at: String = "2026-08-14T10:00:00Z",
        accepted: SessionReviewRequest.Signoff? = nil
    ) -> SessionReviewRequest {
        SessionReviewRequest(to: to, recipients: recipients, by: "Michiel", at: at, accepted: accepted)
    }

    @Test func readsTheOpenSessionsOwnRequestFirst() {
        let state = WorkspaceReview.state(
            of: [
                session(id: "a", request: request(to: "Kent")),
                session(id: "b", request: request(to: "Grant")),
            ],
            openSessionId: "b"
        )
        #expect(state.request?.to == "Grant")
        #expect(state.ownerId == "b")
    }

    /// The sidebar bands group by workspace, so a request set on a sibling has
    /// to reach the open session's panel — carrying the sibling's id, or
    /// clearing it would write to the wrong session.
    @Test func fallsBackToASiblingsRequestAndKeepsItsOwner() {
        let state = WorkspaceReview.state(
            of: [session(id: "a", request: request(to: "Kent")), session(id: "b")],
            openSessionId: "b"
        )
        #expect(state.request?.to == "Kent")
        #expect(state.ownerId == "a")
    }

    @Test func withoutARequestTheOpenSessionOwnsTheNextOne() {
        let state = WorkspaceReview.state(of: [session(id: "b")], openSessionId: "b")
        #expect(state.request == nil)
        #expect(state.ownerId == "b")
    }

    @Test func gathersGithubsReviewersAcrossEveryPrInTheWorkspace() {
        let state = WorkspaceReview.state(
            of: [
                session(id: "a", requested: ["kent"]),
                session(id: "b", requested: ["Kent", "grant"]),
            ],
            openSessionId: "a"
        )
        #expect(state.githubRequested == ["kent", "grant"])
    }

    @Test func aReviewSubmittedOnGithubCompletesTheRequest() {
        let state = WorkspaceReview.state(
            of: [
                session(
                    id: "a",
                    request: request(to: "Kent"),
                    requested: [],
                    reviewedBy: ["kent"],
                    prUpdatedAt: "2026-08-14T11:00:00Z"
                )
            ],
            openSessionId: "a"
        )
        #expect(state.request?.accepted?.by == "Kent")
        #expect(state.acceptedFromPr)
    }

    /// Still listed as a reviewer means the review has not landed: GitHub
    /// drops somebody the instant they submit, and puts them back on a
    /// re-request.
    @Test func aStillPendingReviewerDoesNotCompleteIt() {
        let state = WorkspaceReview.state(
            of: [
                session(
                    id: "a",
                    request: request(to: "Kent"),
                    requested: ["kent"],
                    reviewedBy: ["kent"],
                    prUpdatedAt: "2026-08-14T11:00:00Z"
                )
            ],
            openSessionId: "a"
        )
        #expect(state.request?.accepted == nil)
        #expect(!state.acceptedFromPr)
    }

    /// An older review is the previous round's, not an answer to this ask.
    @Test func aReviewFromBeforeTheAskDoesNotCompleteIt() {
        let state = WorkspaceReview.state(
            of: [
                session(
                    id: "a",
                    request: request(to: "Kent", at: "2026-08-14T12:00:00Z"),
                    requested: [],
                    reviewedBy: ["kent"],
                    prUpdatedAt: "2026-08-14T11:00:00Z"
                )
            ],
            openSessionId: "a"
        )
        #expect(state.request?.accepted == nil)
    }

    @Test func aTeamRequestIsCompletedByAnyOfItsMembers() {
        let state = WorkspaceReview.state(
            of: [
                session(
                    id: "a",
                    request: request(to: "tellahq/reviewers", recipients: ["kent", "grant"]),
                    requested: ["kent"],
                    reviewedBy: ["grant"],
                    prUpdatedAt: "2026-08-14T11:00:00Z"
                )
            ],
            openSessionId: "a"
        )
        #expect(state.request?.accepted?.by == "grant")
    }

    @Test func aSignoffMadeHereIsLeftAlone() {
        let signoff = SessionReviewRequest.Signoff(by: "Kent", at: "2026-08-14T10:30:00Z")
        let state = WorkspaceReview.state(
            of: [
                session(
                    id: "a",
                    request: request(to: "Kent", accepted: signoff),
                    requested: [],
                    reviewedBy: ["kent"],
                    prUpdatedAt: "2026-08-14T11:00:00Z"
                )
            ],
            openSessionId: "a"
        )
        #expect(state.request?.accepted == signoff)
        #expect(!state.acceptedFromPr)
    }

    @Test func aRequestTargetsItsTeamsMembersToo() {
        let team = request(to: "tellahq/reviewers", recipients: ["kent", "grant"])
        #expect(team.targets("Kent"))
        #expect(team.targets("tellahq/reviewers"))
        #expect(!team.targets("alex"))
        #expect(!team.targets(""))
    }
}
