import XCTest
@testable import OS1

final class MermaidSegmenterTests: XCTestCase {
    func testPlainTextStaysOneMarkdownSegment() {
        let text = "# Title\n\nSome prose with `code` in it."
        XCTAssertEqual(MermaidSegmenter.split(text), [.markdown(text)])
    }

    func testFenceBecomesDiagramAndProseSurvives() {
        let text = """
        Before.

        ```mermaid
        graph TD
          A --> B
        ```

        After.
        """
        XCTAssertEqual(MermaidSegmenter.split(text), [
            .markdown("Before.\n"),
            .mermaid("graph TD\n  A --> B"),
            .markdown("\nAfter."),
        ])
    }

    func testTwoDiagramsInOneMessage() {
        let text = """
        ```mermaid
        graph TD
        A-->B
        ```
        Middle.
        ```mermaid
        sequenceDiagram
        A->>B: hi
        ```
        """
        XCTAssertEqual(MermaidSegmenter.split(text), [
            .mermaid("graph TD\nA-->B"),
            .markdown("Middle."),
            .mermaid("sequenceDiagram\nA->>B: hi"),
        ])
    }

    /// What a message looks like mid-stream, and what the transcript's 6k head
    /// clamp can cut it down to: the fence has to stay plain code.
    func testUnterminatedFenceStaysMarkdown() {
        let text = "Here it comes:\n\n```mermaid\ngraph TD\n  A -->"
        XCTAssertEqual(MermaidSegmenter.split(text), [.markdown(text)])
    }

    func testMermaidQuotedInsideAnotherFenceIsNotADiagram() {
        let text = """
        ````markdown
        ```mermaid
        graph TD
        ```
        ````
        """
        XCTAssertEqual(MermaidSegmenter.split(text), [.markdown(text)])
    }

    func testOtherLanguagesKeepTheirCodeBlocks() {
        let text = "```swift\nlet a = 1\n```"
        XCTAssertEqual(MermaidSegmenter.split(text), [.markdown(text)])
    }

    func testInfoStringMustBeExactlyMermaid() {
        let text = "```mermaidjs\nnot a diagram\n```"
        XCTAssertEqual(MermaidSegmenter.split(text), [.markdown(text)])
    }

    func testFourSpaceIndentIsACodeBlockNotAFence() {
        let text = "    ```mermaid\n    graph TD\n    ```"
        XCTAssertEqual(MermaidSegmenter.split(text), [.markdown(text)])
    }

    func testTildeFences() {
        let text = "~~~mermaid\ngraph TD\nA-->B\n~~~"
        XCTAssertEqual(MermaidSegmenter.split(text), [.mermaid("graph TD\nA-->B")])
    }

    func testBlankLinesAroundADiagramDontBecomeEmptySegments() {
        let text = "\n```mermaid\ngraph TD\n```\n\n"
        XCTAssertEqual(MermaidSegmenter.split(text), [.mermaid("graph TD")])
    }

    func testClosingRunMayBeLongerThanTheOpeningOne() {
        let text = "```mermaid\ngraph TD\n`````"
        XCTAssertEqual(MermaidSegmenter.split(text), [.mermaid("graph TD")])
    }

    func testDiagramSourceKeepsCharactersThatWouldBreakStringInterpolation() {
        let text = "```mermaid\ngraph TD\n  A[\"say \\\"hi\\\"\"] --> B\n```"
        XCTAssertEqual(
            MermaidSegmenter.split(text),
            [.mermaid("graph TD\n  A[\"say \\\"hi\\\"\"] --> B")]
        )
    }
}
