import XCTest
@testable import OS1

/// A rewrite that runs over every message an agent writes has to be timid:
/// the failure that matters is not "a path didn't link", it's "a quoted
/// command came out different from what ran".
@MainActor
final class FileLinksTests: XCTestCase {
    private let session = "os-test"

    override func setUp() async throws {
        FileLinks.register(
            paths: ["src/server/pr.ts", "src/server", "packages/clients/ios/OS1/Views/My File.swift"],
            for: session
        )
    }

    private func linkify(_ markdown: String) -> String {
        FileLinks.linkify(markdown, sessionId: session)
    }

    /// A path in backticks loses them when it becomes a link — deliberately.
    /// The renderer keeps a code span's own font and colour over the link's,
    /// so a code-voice label would be tappable and look exactly like the
    /// un-tappable code beside it.
    func testCodespanPathLinksAsPlainText() {
        XCTAssertEqual(
            linkify("moved the guard into `src/server/pr.ts` today"),
            "moved the guard into [src/server/pr.ts](os1file:src/server/pr.ts) today"
        )
    }

    func testBarePathBecomesALink() {
        XCTAssertEqual(
            linkify("see src/server/pr.ts"),
            "see [src/server/pr.ts](os1file:src/server/pr.ts)"
        )
    }

    /// The composer inserts `@path`; the "@" belongs to the label, never to
    /// the target.
    func testMentionKeepsItsAtInTheLabelOnly() {
        XCTAssertEqual(
            linkify("@src/server/pr.ts please"),
            "[@src/server/pr.ts](os1file:src/server/pr.ts) please"
        )
    }

    /// Longest first: a registered parent directory must not eat the file
    /// under it and split the path in two.
    func testLongestPathWins() {
        XCTAssertEqual(
            linkify("src/server/pr.ts"),
            "[src/server/pr.ts](os1file:src/server/pr.ts)"
        )
    }

    /// The registered `src/server` is a prefix of this one — linking its
    /// first half would be worse than not linking at all.
    func testUnregisteredPathIsLeftAlone() {
        let text = "look at src/server/other.ts"
        XCTAssertEqual(linkify(text), text)
    }

    /// How anyone actually refers to a file in a sentence.
    func testBasenameLinksToTheFullPath() {
        XCTAssertEqual(
            linkify("the guard now lives in `pr.ts`"),
            "the guard now lives in [pr.ts](os1file:src/server/pr.ts)"
        )
    }

    func testTrailingSegmentsLinkToTheFullPath() {
        XCTAssertEqual(
            linkify("see server/pr.ts"),
            "see [server/pr.ts](os1file:src/server/pr.ts)"
        )
    }

    /// Two touched files with the same name make that name mean neither.
    func testAmbiguousBasenameIsNotLinked() {
        FileLinks.register(
            paths: ["src/server/index.ts", "src/client/index.ts"],
            for: session
        )
        XCTAssertEqual(linkify("open index.ts"), "open index.ts")
        XCTAssertEqual(
            linkify("open server/index.ts"),
            "open [server/index.ts](os1file:src/server/index.ts)"
        )
    }

    func testPathEndingASentenceStillLinks() {
        XCTAssertEqual(
            linkify("It lives in src/server/pr.ts."),
            "It lives in [src/server/pr.ts](os1file:src/server/pr.ts)."
        )
    }

    func testExistingLinkIsNotRewritten() {
        let text = "[the route](https://example.com/src/server/pr.ts) is fine"
        XCTAssertEqual(linkify(text), text)
    }

    func testFencedCodeIsUntouched() {
        let text = """
        Run this:

        ```sh
        bun test src/server/pr.ts
        ```
        """
        XCTAssertEqual(linkify(text), text)
    }

    func testIndentedCodeIsUntouched() {
        let text = "    bun test src/server/pr.ts"
        XCTAssertEqual(linkify(text), text)
    }

    /// A destination cannot carry a raw space — it would end the link.
    func testPathWithSpacesIsEncoded() {
        XCTAssertEqual(
            linkify("`packages/clients/ios/OS1/Views/My File.swift`"),
            "[packages/clients/ios/OS1/Views/My File.swift]"
            + "(os1file:packages/clients/ios/OS1/Views/My%20File.swift)"
        )
    }

    func testNoSessionMeansNoLinks() {
        let text = "see src/server/pr.ts"
        XCTAssertEqual(FileLinks.linkify(text, sessionId: nil), text)
        XCTAssertEqual(FileLinks.linkify(text, sessionId: "os-unknown"), text)
    }

    func testRoundTripsThroughTheURL() {
        let linked = linkify("`packages/clients/ios/OS1/Views/My File.swift`")
        let start = linked.range(of: "(os1file:")!.upperBound
        let end = linked.range(of: ")", range: start..<linked.endIndex)!.lowerBound
        let url = URL(string: "os1file:" + linked[start..<end])!
        XCTAssertEqual(
            FileLinks.path(from: url),
            "packages/clients/ios/OS1/Views/My File.swift"
        )
    }

    func testOtherSchemesAreNotFileLinks() {
        XCTAssertNil(FileLinks.path(from: URL(string: "https://example.com/a.ts")!))
        XCTAssertNil(FileLinks.path(from: URL(string: "os1session:os-1")!))
    }

    /// A path inside a longer word is not that path.
    func testPartialWordIsNotAPath() {
        let text = "unrelated-src/server/pr.tsx"
        XCTAssertEqual(linkify(text), text)
    }
}
