import Foundation
import Testing
@testable import OS1

/// What reaches the review canvas's conversation. The rules are the web's
/// (`stripHtmlComments` and `isOutdatedReviewComment` in lib/pr-comments):
/// a comment that is only bookkeeping is not discussion, and a superseded
/// automated review stays on GitHub rather than in the list.
struct PrConversationTests {
    private func comment(_ body: String) -> PrComment {
        PrComment(author: "kentdebruin", body: body, createdAt: nil, url: nil)
    }

    @Test func stripsTheHiddenMarkerFromAReviewWriteUp() {
        let review = comment("<!-- os-review -->\n### OS review\nSafe to merge.")
        #expect(review.discussionBody == "### OS review\nSafe to merge.")
        #expect(review.isDiscussion)
    }

    @Test func aCommentThatIsOnlyAMarkerIsNotDiscussion() {
        #expect(!comment("<!-- os-pr-bookkeeping -->").isDiscussion)
        #expect(!comment("   \n\t ").isDiscussion)
    }

    @Test func aSupersededAutomatedReviewIsDropped() {
        let stale = comment("<!-- os-review-outdated -->\nAn older reading.")
        #expect(stale.isOutdatedReview)
        #expect(!stale.isDiscussion)
        // The legacy spelling is still on old pull requests.
    }

    @Test func anOrdinaryCommentSurvivesIntact() {
        let human = comment("This reads well. One question about the retry.")
        #expect(human.isDiscussion)
        #expect(human.discussionBody == "This reads well. One question about the retry.")
        #expect(!human.isOutdatedReview)
    }

    @Test func markersInsideAParagraphAreRemovedWithoutEatingTheProse() {
        let mixed = comment("Before <!-- hidden --> after")
        #expect(mixed.discussionBody == "Before  after")
        #expect(mixed.isDiscussion)
    }
}
