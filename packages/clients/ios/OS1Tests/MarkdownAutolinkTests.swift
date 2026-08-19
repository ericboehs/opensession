import XCTest
@testable import OS1

final class MarkdownAutolinkTests: XCTestCase {
    func testBareUrlBecomesLink() {
        XCTAssertEqual(
            MarkdownAutolink.linkify("opened https://github.com/tellahq/x/pull/1 for review"),
            "opened [https://github.com/tellahq/x/pull/1](https://github.com/tellahq/x/pull/1) for review"
        )
    }

    func testTextWithoutUrlIsUnchanged() {
        let text = "no links here — just prose about http things"
        XCTAssertEqual(MarkdownAutolink.linkify(text), text)
    }

    func testSentencePunctuationStaysOutsideTheLink() {
        XCTAssertEqual(
            MarkdownAutolink.linkify("see https://tella.tv."),
            "see [https://tella.tv](https://tella.tv)."
        )
        XCTAssertEqual(
            MarkdownAutolink.linkify("(https://tella.tv)"),
            "([https://tella.tv](https://tella.tv))"
        )
    }

    func testBalancedParensStayInTheLink() {
        let url = "https://en.wikipedia.org/wiki/Ruby_(programming_language)"
        XCTAssertEqual(MarkdownAutolink.linkify(url), "[\(url)](\(url))")
    }

    func testExistingLinksAreLeftAlone() {
        let cases = [
            "[the PR](https://github.com/tellahq/x/pull/1)",
            "![shot](https://example.com/a.png)",
            "<https://tella.tv>",
            "`curl https://tella.tv`",
            "[docs]: https://tella.tv",
        ]
        for text in cases {
            XCTAssertEqual(MarkdownAutolink.linkify(text), text, text)
        }
    }

    func testUrlAfterAnExistingLinkOnTheSameLineIsStillLinked() {
        XCTAssertEqual(
            MarkdownAutolink.linkify("[PR](https://example.com/1) and https://example.com/2"),
            "[PR](https://example.com/1) and [https://example.com/2](https://example.com/2)"
        )
    }

    func testCodeBlocksAreLeftAlone() {
        let text = """
        Run it:

        ```sh
        curl https://tella.tv
        ```

        then open https://tella.tv
        """
        let out = MarkdownAutolink.linkify(text)
        XCTAssertTrue(out.contains("curl https://tella.tv\n"), out)
        XCTAssertTrue(out.contains("then open [https://tella.tv](https://tella.tv)"), out)
    }

    func testIndentedCodeIsLeftAlone() {
        let text = "    curl https://tella.tv"
        XCTAssertEqual(MarkdownAutolink.linkify(text), text)
    }

    @MainActor
    func testSessionUrlSurvivesSessionLinkRewriting() {
        let id = "bks-019fcead-adc4-7000-b0da-8a5af66819c7"
        let url = "https://os.tella.dev/session/\(id)"
        // The order MarkdownBody uses: autolink first, then session ids.
        let out = SessionLinks.linkify(MarkdownAutolink.linkify("see \(url) for it"))
        XCTAssertEqual(out, "see [\(url)](\(url)) for it")
    }
}
