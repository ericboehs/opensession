import XCTest
@testable import OS1

final class SyntaxHighlightingTests: XCTestCase {
    func testPWAFileLanguagesHaveNativeEquivalents() {
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "src/App.tsx"), "typescript")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "script.sh"), "bash")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "theme.css"), "css")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "change.patch"), "diff")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "View.swift"), "swift")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "config.cjs"), "javascript")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "types.mts"), "typescript")
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "Dockerfile"), "dockerfile")
    }

    func testLanguageInferenceIsCaseInsensitive() {
        XCTAssertEqual(SyntaxHighlighting.language(forPath: "CONFIG.YML"), "yaml")
        XCTAssertEqual(SyntaxHighlighting.language(forExtension: "JSONC"), "json")
        XCTAssertEqual(SyntaxHighlighting.language(forExtension: "rust"), "rust")
    }

    func testUnknownAndPlainTextFilesStayPlain() {
        XCTAssertNil(SyntaxHighlighting.language(forPath: "notes.txt"))
        XCTAssertNil(SyntaxHighlighting.language(forPath: "archive.bin"))
        XCTAssertNil(SyntaxHighlighting.language(forPath: nil))
    }

    func testReadLineNumbersAreSplitIntoAGutter() {
        XCTAssertEqual(
            SyntaxHighlighting.splitGutter(" 1\tlet one = 1\n12\tlet two = 2"),
            .init(labels: " 1\n12", code: "let one = 1\nlet two = 2")
        )
    }

    func testGrepLineNumbersAreSplitOnlyWhenMostLinesMatch() {
        XCTAssertEqual(
            SyntaxHighlighting.splitGutter("2:first\n9-second\n--\n10:last"),
            .init(labels: " 2:\n 9-\n--\n10:", code: "first\nsecond\n\nlast")
        )
        XCTAssertNil(SyntaxHighlighting.splitGutter("result.swift\n2:first"))
    }

    func testHighlightingRestoresSignificantEdgeWhitespace() {
        let source = "  return value\n"
        let highlighted = AttributedString("return value")

        let restored = SyntaxHighlighting.restoringEdgeWhitespace(
            highlighted,
            in: source,
            fallbackColor: OS1VisualStyle.textDim
        )

        XCTAssertEqual(String(restored.characters), source)
    }
}
