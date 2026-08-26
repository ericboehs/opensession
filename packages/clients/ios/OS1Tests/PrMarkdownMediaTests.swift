import XCTest
@testable import OS1

final class PrMarkdownMediaTests: XCTestCase {
    private let id = "d087b2cd-9724-4d3d-8b0e-8c25700395e1"
    private let base = URL(string: "https://os.example.test")!

    private var source: String {
        "https://github.com/user-attachments/assets/\(id)"
    }

    private var proxy: String {
        "https://os.example.test/gh-asset/\(id)?repo=opensession"
    }

    func testRewritesImageAndLinkTargetsThroughCurrentServer() {
        let markdown = "![After](\(source))\n\n[Open](\(source))"

        XCTAssertEqual(
            PrMarkdownMedia.rewrite(markdown, repo: "opensession", baseURL: base),
            "![After](\(proxy))\n\n[Open](\(proxy))"
        )
    }

    func testRewritesExpiredSignedAttachmentURL() {
        let signed = "https://private-user-images.githubusercontent.com/213769834/636480332-\(id).png?jwt=expired"

        XCTAssertEqual(
            PrMarkdownMedia.rewrite("![After](\(signed))", repo: "opensession", baseURL: base),
            "![After](\(proxy))"
        )
    }

    func testLeavesAttachmentURLsInsideCodeUntouched() {
        let markdown = "`\(source)`\n\n```markdown\n![After](\(source))\n```\n\n    \(source)"

        XCTAssertEqual(
            PrMarkdownMedia.rewrite(markdown, repo: "opensession", baseURL: base),
            markdown
        )
    }

    func testLeavesMarkdownUntouchedWithoutRepoOrServer() {
        XCTAssertEqual(
            PrMarkdownMedia.rewrite(source, repo: nil, baseURL: base),
            source
        )
        XCTAssertEqual(
            PrMarkdownMedia.rewrite(source, repo: "opensession", baseURL: nil),
            source
        )
    }

    func testBareAttachmentURLRendersAsInlineVideoBlock() {
        XCTAssertEqual(
            PrMarkdownMedia.blocks(
                in: "Before\n\n\(source)\n\nAfter",
                repo: "opensession",
                baseURL: base
            ),
            [
                .markdown("Before\n"),
                .video(URL(string: proxy)!),
                .markdown("\nAfter"),
            ]
        )
    }

    func testLabelledAttachmentLinkStaysMarkdown() {
        XCTAssertEqual(
            PrMarkdownMedia.blocks(
                in: "[Watch the demo](\(source))",
                repo: "opensession",
                baseURL: base
            ),
            [.markdown("[Watch the demo](\(proxy))")]
        )
    }

    func testBareAttachmentInsideFenceStaysMarkdown() {
        let markdown = "````markdown\n~~~\n```\n\(source)\n````"
        XCTAssertEqual(
            PrMarkdownMedia.blocks(
                in: markdown,
                repo: "opensession",
                baseURL: base
            ),
            [.markdown(markdown)]
        )
    }
}
