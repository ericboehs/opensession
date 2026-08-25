import XCTest
@testable import OS1

/// Pins the same conservative commit-reference grammar as the web renderer.
@MainActor
final class CommitLinksTests: XCTestCase {
    private let session = "os-test"

    override func setUp() async throws {
        CommitLinks.register(repos: [
            "opensession": "tellahq/opensession",
            "tella-fusion": "tellahq/tella-fusion",
        ])
        CommitLinks.register(sessionRepos: [session: "opensession"])
    }

    func testCodeSpanAndCueBecomeCodeShapedLinks() {
        XCTAssertEqual(
            CommitLinks.linkify("Reverted `4ed1ef09`.", sessionId: session),
            "Reverted [`4ed1ef09`](os1commit:opensession/4ed1ef09)."
        )
        XCTAssertEqual(
            CommitLinks.linkify("Fixed in commit 4ED1EF09 last night.", sessionId: session),
            "Fixed in commit [`4ed1ef09`](os1commit:opensession/4ed1ef09) last night."
        )
        XCTAssertTrue(
            CommitLinks.linkify("commits 4ed1ef09 and sha 437cba77", sessionId: session)
                .contains("sha [`437cba77`](os1commit:opensession/437cba77)")
        )
    }

    func testFullAndUppercaseShaAreAccepted() {
        let full = String(repeating: "a", count: 39) + "1"
        XCTAssertTrue(
            CommitLinks.linkify("Pinned at `\(full)`.", sessionId: session)
                .contains("os1commit:opensession/\(full)")
        )
        XCTAssertTrue(
            CommitLinks.linkify("Pinned at `4ED1EF09`.", sessionId: session)
                .contains("os1commit:opensession/4ed1ef09")
        )
    }

    func testHexWithoutACueAndNonCommitShapesStayPlain() {
        let samples = [
            "The id 4ed1ef09 came back from the API.",
            "precommit 4ed1ef09 hook",
            "`1786042878` is epoch milliseconds",
            "`f6f8fa` is a colour",
            "`120a8d94363c2d90b7b92710f58cf9ce` is an md5",
            "`b43e9281b96037e3` is a 16-hex id",
            "`4ed1ef09g` is not hex",
        ]
        for sample in samples {
            XCTAssertEqual(CommitLinks.linkify(sample, sessionId: session), sample, sample)
        }
    }

    func testCodeAndExplicitLinksStayUntouched() {
        let markdown = """
        [see `4ed1ef09`](https://example.com/x)

        ```sh
        git show 4ed1ef09
        ```

            git show 437cba77
        """
        XCTAssertEqual(CommitLinks.linkify(markdown, sessionId: session), markdown)
    }

    func testBareConfiguredGitHubURLBecomesAReference() {
        let full = "4ed1ef09aa11bb22cc33dd44ee55ff6600778899"
        XCTAssertEqual(
            CommitLinks.linkify(
                "https://github.com/tellahq/opensession/commit/\(full)",
                sessionId: session
            ),
            "[`4ed1ef09`](os1commit:opensession/\(full))"
        )
        let labelled = "[the revert](https://github.com/tellahq/opensession/commit/\(full))"
        XCTAssertEqual(CommitLinks.linkify(labelled, sessionId: session), labelled)
        let bareLink = "[https://github.com/tellahq/opensession/commit/\(full)](https://github.com/tellahq/opensession/commit/\(full))"
        XCTAssertEqual(
            CommitLinks.linkify(bareLink, sessionId: session),
            "[`4ed1ef09`](os1commit:opensession/\(full))"
        )
        let upstream = "https://github.com/vercel/next.js/commit/4ed1ef09"
        XCTAssertEqual(CommitLinks.linkify(upstream, sessionId: session), upstream)
    }

    func testReferenceRoundTripsAndRejectsNonShaPaths() {
        XCTAssertEqual(
            CommitLinks.reference(from: URL(string: "os1commit:opensession/4ED1EF09")!),
            CommitLinks.Reference(repo: "opensession", sha: "4ed1ef09")
        )
        XCTAssertNil(CommitLinks.reference(from: URL(string: "os1commit:opensession/not-a-sha")!))
        XCTAssertNil(CommitLinks.reference(from: URL(string: "https://github.com")!))
    }

    func testWithoutASessionRepoNothingIsClaimed() {
        let source = "Reverted `4ed1ef09`."
        XCTAssertEqual(CommitLinks.linkify(source, sessionId: nil), source)

        let full = "4ed1ef09aa11bb22cc33dd44ee55ff6600778899"
        XCTAssertEqual(
            CommitLinks.linkify(
                "https://github.com/tellahq/opensession/commit/\(full)",
                sessionId: nil
            ),
            "[`4ed1ef09`](os1commit:opensession/\(full))"
        )
    }
}
