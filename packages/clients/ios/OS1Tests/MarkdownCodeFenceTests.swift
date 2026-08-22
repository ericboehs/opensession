import XCTest
@testable import OS1

final class MarkdownCodeFenceTests: XCTestCase {
    func testOneLineFenceCopiesOnlyItsContents() throws {
        let segments = MarkdownCodeFenceParser.split("Before\n\n```swift\nprint(1)\n```\n\nAfter")
        let fence = try XCTUnwrap(segments.compactMap(\.fence).first)
        let clipboard = RecordingCodeFenceClipboard()

        fence.copy(to: clipboard)

        XCTAssertEqual(fence.language, "swift")
        XCTAssertEqual(clipboard.text, "print(1)")
    }

    func testMultilineFencePreservesLineBreaksWhenCopied() throws {
        let segments = MarkdownCodeFenceParser.split("~~~bash\nprintf 'one\\n'\nprintf 'two\\n'\n~~~")
        let fence = try XCTUnwrap(segments.compactMap(\.fence).first)
        let clipboard = RecordingCodeFenceClipboard()

        fence.copy(to: clipboard)

        XCTAssertEqual(clipboard.text, "printf 'one\\n'\nprintf 'two\\n'")
    }

    func testCompleteExampleInsideUnclosedLongerFenceIsNotExtracted() {
        let markdown = """
        ````text
        An example:
        ```swift
        print(1)
        ```
        """

        XCTAssertEqual(MarkdownCodeFenceParser.split(markdown), [.markdown(markdown)])
    }
}

private final class RecordingCodeFenceClipboard: CodeFenceClipboard {
    var text: String?

    func write(_ text: String) {
        self.text = text
    }
}

private extension MarkdownCodeFenceSegment {
    var fence: MarkdownCodeFence? {
        if case .fence(let fence) = self {
            return fence
        }
        return nil
    }
}
