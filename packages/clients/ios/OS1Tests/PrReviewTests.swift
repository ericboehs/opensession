import XCTest
@testable import OS1

final class PrReviewTests: XCTestCase {
    func testParsesHunksWithBothLineNumberSpaces() {
        let patch = """
        diff --git a/Sources/App.swift b/Sources/App.swift
        index 111..222 100644
        --- a/Sources/App.swift
        +++ b/Sources/App.swift
        @@ -10,3 +10,4 @@ struct App {
         let unchanged = true
        -let old = false
        +let new = true
        +let added = true
         }
        """

        let files = PrPatchParser.files(in: patch)
        XCTAssertEqual(files.map(\.path), ["Sources/App.swift"])
        XCTAssertEqual(files[0].lines.compactMap(\.oldLine), [10, 11, 12])
        XCTAssertEqual(files[0].lines.compactMap(\.newLine), [10, 11, 12, 13])
        XCTAssertEqual(
            files[0].lines.filter { $0.kind == .deletion }.first?.commentLine,
            nil
        )
        XCTAssertEqual(
            files[0].lines.filter { $0.kind == .addition }.map(\.commentLine),
            [11, 12]
        )
    }

    func testUsesOldPathForDeletedFile() {
        let patch = """
        diff --git a/Gone.swift b/Gone.swift
        deleted file mode 100644
        --- a/Gone.swift
        +++ /dev/null
        @@ -1 +0,0 @@
        -gone
        """

        XCTAssertEqual(PrPatchParser.files(in: patch).map(\.path), ["Gone.swift"])
    }

    func testInlineCommentIdentityIsOneAnchorPerLine() {
        let first = PrInlineComment(path: "App.swift", line: 12, text: "First")
        let replacement = PrInlineComment(path: "App.swift", line: 12, text: "Replacement")
        XCTAssertEqual(first.id, replacement.id)
    }
}
