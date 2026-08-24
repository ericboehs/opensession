import XCTest
@testable import OS1

final class MarkdownTableSegmenterTests: XCTestCase {
    func testPlainProseIsOneSegment() {
        let text = "Nothing here, not even a pipe."
        XCTAssertEqual(MarkdownTableSegmenter.split(text), [.markdown(text)])
    }

    func testSplitsATableOutOfProse() {
        let text = """
        Before the table.

        | Language | Typing |
        | --- | --- |
        | Swift | Static |
        | Ruby | Dynamic |

        After the table.
        """
        let segments = MarkdownTableSegmenter.split(text)
        XCTAssertEqual(segments.count, 3)
        guard case .markdown(let head) = segments[0] else { return XCTFail("no head") }
        XCTAssertEqual(head, "Before the table.\n")
        guard case .table(let table) = segments[1] else { return XCTFail("no table") }
        XCTAssertEqual(table.headers, ["Language", "Typing"])
        XCTAssertEqual(table.rows, [["Swift", "Static"], ["Ruby", "Dynamic"]])
        guard case .markdown(let tail) = segments[2] else { return XCTFail("no tail") }
        XCTAssertEqual(tail, "\nAfter the table.")
    }

    func testTableAtTheVeryStart() {
        let text = """
        | A | B |
        |---|---|
        | 1 | 2 |
        """
        XCTAssertEqual(
            MarkdownTableSegmenter.split(text),
            [.table(MarkdownTable(
                headers: ["A", "B"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]]
            ))]
        )
    }

    func testAlignmentsFromTheDelimiterRow() {
        let text = """
        | A | B | C |
        |:--|:-:|--:|
        | 1 | 2 | 3 |
        """
        guard case .table(let table)? = MarkdownTableSegmenter.split(text).first else {
            return XCTFail("no table")
        }
        XCTAssertEqual(table.alignments, [.leading, .center, .trailing])
    }

    func testCellsKeepInlineMarkdownAndUnescapePipes() {
        let text = """
        | Name | Note |
        | --- | --- |
        | `a\\|b` | **bold** and [link](https://x.dev) |
        """
        guard case .table(let table)? = MarkdownTableSegmenter.split(text).first else {
            return XCTFail("no table")
        }
        XCTAssertEqual(table.rows, [["`a|b`", "**bold** and [link](https://x.dev)"]])
    }

    func testShortRowsArePaddedAndLongRowsTruncated() {
        let text = """
        | A | B | C |
        | --- | --- | --- |
        | 1 |
        | 1 | 2 | 3 | 4 |
        """
        guard case .table(let table)? = MarkdownTableSegmenter.split(text).first else {
            return XCTFail("no table")
        }
        XCTAssertEqual(table.rows, [["1", "", ""], ["1", "2", "3"]])
    }

    func testATableInsideAFenceStaysMarkdown() {
        let text = """
        ```markdown
        | A | B |
        |---|---|
        | 1 | 2 |
        ```
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(text), [.markdown(text)])
    }

    func testAQuotedOrListedTableStaysMarkdown() {
        let quoted = """
        > | A | B |
        > |---|---|
        > | 1 | 2 |
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(quoted), [.markdown(quoted)])

        let listed = """
        - | A | B |
          |---|---|
          | 1 | 2 |
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(listed), [.markdown(listed)])
    }

    func testATableCannotInterruptAParagraph() {
        let text = """
        Here is a table:
        | A | B |
        |---|---|
        | 1 | 2 |
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(text), [.markdown(text)])
    }

    func testAHalfArrivedTableStaysMarkdown() {
        let headerOnly = "| A | B |"
        XCTAssertEqual(MarkdownTableSegmenter.split(headerOnly), [.markdown(headerOnly)])

        let noBody = """
        | A | B |
        |---|---|
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(noBody), [.markdown(noBody)])

        let mismatched = """
        | A | B |
        |---|
        | 1 | 2 |
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(mismatched), [.markdown(mismatched)])
    }

    func testProseWithAPipeIsNotATable() {
        let text = """
        Run `a | b` and then check.

        The pipeline uses | as a separator.
        """
        XCTAssertEqual(MarkdownTableSegmenter.split(text), [.markdown(text)])
    }

    /// The whole point of owning the table: prose columns wrap instead of the
    /// row running off the side of the message.
    @MainActor
    func testAWideTableWrapsIntoTheWidthItIsGiven() {
        let table = MarkdownTable(
            headers: ["Language", "Typing", "Runtime", "Best known for"],
            alignments: [.leading, .leading, .leading, .leading],
            rows: [
                [
                    "Rust", "Static", "Compiled",
                    "Rust is known for memory safety without garbage collection, "
                        + "which makes it a fit for systems programming.",
                ],
                [
                    "TypeScript", "Static", "Compiled to JavaScript",
                    "TypeScript adds static typing to JavaScript and is popular "
                        + "for large web applications.",
                ],
            ]
        )
        let available: CGFloat = 360
        let gutter: CGFloat = 16
        let plan = TableLayoutPlan(
            table: MeasuredTable(table),
            available: available,
            gutter: gutter
        )
        XCTAssertTrue(plan.fits)
        let total = plan.widths.reduce(0, +) + gutter * CGFloat(plan.widths.count - 1)
        XCTAssertLessThanOrEqual(total, available)
        // The sentence column gives up the most; the one-word columns keep
        // roughly what they asked for.
        XCTAssertGreaterThan(plan.widths[3], 0)
        XCTAssertLessThan(plan.widths[3], plan.widths.reduce(0, +))
    }

    /// A table with no room left even at its longest word scrolls rather than
    /// squeezing every column into nothing.
    @MainActor
    func testATableThatCannotWrapFallsBackToScrolling() {
        let headers = (1...12).map { "Column\($0)" }
        let table = MarkdownTable(
            headers: headers,
            alignments: Array(repeating: .leading, count: headers.count),
            rows: [(1...12).map { "Extraordinarily\($0)" }]
        )
        let plan = TableLayoutPlan(
            table: MeasuredTable(table),
            available: 360,
            gutter: 16
        )
        XCTAssertFalse(plan.fits)
    }

    @MainActor
    func testANarrowTableKeepsItsNaturalWidth() {
        let table = MarkdownTable(
            headers: ["A", "B"],
            alignments: [.leading, .leading],
            rows: [["1", "2"]]
        )
        let plan = TableLayoutPlan(table: MeasuredTable(table), available: 360, gutter: 16)
        XCTAssertTrue(plan.fits)
        XCTAssertLessThan(plan.widths.reduce(0, +), 200)
    }

    /// The shape agents actually write for a before/after comparison: a
    /// nameless first column holding the row labels.
    func testAnEmptyLeadingHeaderCell() {
        let text = """
        | | Before | After |
        |---|---|---|
        | Page frame | bespoke 1040px column | `PageHeader` in a 920px column |
        | Filters | bare text | `Input` primitive for search |
        """
        guard case .table(let table)? = MarkdownTableSegmenter.split(text).first else {
            return XCTFail("no table")
        }
        XCTAssertEqual(table.headers, ["", "Before", "After"])
        XCTAssertEqual(table.rows.count, 2)
        XCTAssertEqual(table.rows[0][0], "Page frame")
    }

    /// The handover to the library's scrolling table has to round-trip, or a
    /// too-wide table comes out as prose full of pipes.
    func testMarkdownSourceRoundTrips() {
        let text = """
        | A | B | C |
        |:--|:-:|--:|
        | 1 | `x\\|y` | [link](https://x.dev) |
        """
        guard case .table(let table)? = MarkdownTableSegmenter.split(text).first else {
            return XCTFail("no table")
        }
        guard case .table(let again)? =
            MarkdownTableSegmenter.split(table.markdownSource()).first else {
            return XCTFail("source did not parse back into a table")
        }
        XCTAssertEqual(again, table)
    }

    func testTwoTablesInOneMessage() {
        let text = """
        | A | B |
        |---|---|
        | 1 | 2 |

        Between.

        | C | D |
        |---|---|
        | 3 | 4 |
        """
        let segments = MarkdownTableSegmenter.split(text)
        XCTAssertEqual(segments.count, 3)
        if case .table = segments[0] {} else { XCTFail("first is not a table") }
        if case .markdown = segments[1] {} else { XCTFail("middle is not prose") }
        if case .table = segments[2] {} else { XCTFail("last is not a table") }
    }
}
