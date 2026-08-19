import XCTest
@testable import OS1

final class ShippedChangeCopyTests: XCTestCase {
    func testUsesWalkthroughOutcomeBeforePullRequestTitle() {
        XCTAssertEqual(
            ShippedChangeCopy.suggestion(
                title: "Polish the composer",
                repo: "opensession",
                summary: "The Slack composer now keeps selected images while reconnecting.\n\nVerified on iOS."
            ),
            "The Slack composer now keeps selected images while reconnecting."
        )
    }

    func testFallsBackToRepositoryAwareTitle() {
        XCTAssertEqual(
            ShippedChangeCopy.suggestion(
                title: "Polish the Slack composer",
                repo: "tella-fusion",
                summary: nil
            ),
            "The Slack composer is now improved in Tella."
        )
    }

    func testFindsNewestLocalFeaturedScreenshot() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            ["id": "1", "type": "assistant", "featuredMedia": ["https://example.com/remote.png"]],
            ["id": "2", "type": "assistant", "featuredMedia": ["/tmp/after.png"]],
        ])
        let entries = try JSONDecoder().decode([TranscriptEntry].self, from: data)

        XCTAssertEqual(ShippedChangeMedia.latestScreenshot(in: entries), "/tmp/after.png")
    }
}
