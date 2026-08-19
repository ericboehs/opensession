import XCTest
@testable import OS1

/// The parser's contract, driven the way a PTY drives it: arbitrary chunks of
/// output, escape sequences that may straddle a chunk boundary, and programs
/// that redraw a line rather than writing a new one.
final class TerminalScrollbackTests: XCTestCase {
    private func scrollback(_ chunks: String...) -> TerminalScrollback {
        var buffer = TerminalScrollback()
        for chunk in chunks { buffer.feed(chunk) }
        return buffer
    }

    // MARK: - Plain text

    func testSplitsOnNewlines() {
        let buffer = scrollback("one\ntwo\nthree")
        XCTAssertEqual(buffer.lines.map(\.text), ["one", "two", "three"])
    }

    func testLineIdentityIsStableAcrossFeeds() {
        var buffer = TerminalScrollback()
        buffer.feed("first\n")
        let firstId = buffer.lines[0].id
        buffer.feed("second\n")
        XCTAssertEqual(buffer.lines[0].id, firstId, "an existing line must keep its identity")
        XCTAssertNotEqual(buffer.lines[1].id, firstId)
    }

    // MARK: - Cursor motion within a line

    func testCarriageReturnRedrawsTheLineInPlace() {
        // What every progress bar and spinner does.
        let buffer = scrollback("Building... 10%\rBuilding... 90%")
        XCTAssertEqual(buffer.lines.map(\.text), ["Building... 90%"])
    }

    func testCarriageReturnLeavesTheTailOfALongerPreviousWrite() {
        // Faithful to a real terminal: overwriting is not erasing.
        let buffer = scrollback("123456\rab")
        XCTAssertEqual(buffer.lines.map(\.text), ["ab3456"])
    }

    func testEraseInLineClearsTheTailAfterCarriageReturn() {
        // The other half of the idiom: \r + ESC[K is how a spinner erases.
        let buffer = scrollback("Building... 100%\r\u{1B}[Kdone")
        XCTAssertEqual(buffer.lines.map(\.text), ["done"])
    }

    func testBackspaceRubsOutACharacter() {
        let buffer = scrollback("cato\u{8} ")
        XCTAssertEqual(buffer.lines.map(\.text), ["cat"])
    }

    func testTabAdvancesToTheNextStop() {
        let buffer = scrollback("ab\tc")
        XCTAssertEqual(buffer.lines.map(\.text), ["ab      c"])
    }

    // MARK: - Colour

    func testParsesForegroundColour() {
        let buffer = scrollback("plain \u{1B}[31mred\u{1B}[0m tail")
        XCTAssertEqual(buffer.lines[0].text, "plain red tail")
        XCTAssertEqual(
            buffer.lines[0].runs.map(\.style.ink),
            [nil, .indexed(1), nil]
        )
    }

    func testParsesBrightAndTwoFiftySixColour() {
        let buffer = scrollback("\u{1B}[92mbright\u{1B}[38;5;208morange\u{1B}[m")
        XCTAssertEqual(
            buffer.lines[0].runs.map(\.style.ink),
            [.indexed(10), .indexed(208)]
        )
    }

    func testParsesTwentyFourBitColour() {
        let buffer = scrollback("\u{1B}[38;2;255;128;0mamber")
        XCTAssertEqual(buffer.lines[0].runs.first?.style.ink, .rgb(r: 255, g: 128, b: 0))
    }

    func testBackgroundColourIsDroppedWithoutSwallowingWhatFollows() {
        // `48;5;n` must be stepped over, or the palette index reads as a
        // fresh SGR code and paints the text some unrelated colour.
        let buffer = scrollback("\u{1B}[48;5;196;32mgreen on red")
        XCTAssertEqual(buffer.lines[0].text, "green on red")
        XCTAssertEqual(buffer.lines[0].runs.first?.style.ink, .indexed(2))
    }

    func testBoldAndDim() {
        let buffer = scrollback("\u{1B}[1mbold\u{1B}[22m normal \u{1B}[2mdim")
        let styles = buffer.lines[0].runs.map(\.style)
        XCTAssertEqual(styles.first?.bold, true)
        XCTAssertEqual(styles.last?.dim, true)
        XCTAssertEqual(styles.last?.bold, false)
    }

    // MARK: - Sequences that must be discarded, not printed

    func testUnsupportedSequencesLeaveNoLitter() {
        // A window title (OSC), cursor hiding (a private sequence), a cursor
        // move, and a charset designation. None may reach the text.
        let buffer = scrollback(
            "\u{1B}]0;my title\u{7}\u{1B}[?25lhello\u{1B}[2A\u{1B}(Bworld"
        )
        XCTAssertEqual(buffer.lines.map(\.text), ["helloworld"])
    }

    func testOperatingSystemCommandTerminatedByStringTerminator() {
        let buffer = scrollback("\u{1B}]7;file://host/tmp\u{1B}\\ok")
        XCTAssertEqual(buffer.lines.map(\.text), ["ok"])
    }

    func testEscapeSequenceSplitAcrossChunksStillParses() {
        // The reason the parser is a resumable state machine: a WebSocket
        // frame boundary lands wherever it lands.
        let buffer = scrollback("red: \u{1B}[3", "1mfail\u{1B}", "[0m done")
        XCTAssertEqual(buffer.lines[0].text, "red: fail done")
        XCTAssertEqual(buffer.lines[0].runs.map(\.style.ink), [nil, .indexed(1), nil])
    }

    func testRunawaySequenceIsAbandonedRatherThanEatingTheOutput() {
        let buffer = scrollback("\u{1B}[" + String(repeating: "9", count: 80) + "recovered\n")
        XCTAssertTrue(
            buffer.plainText.contains("recovered"),
            "a malformed sequence must not swallow everything after it"
        )
    }

    func testScreenClearEmptiesTheBuffer() {
        var buffer = scrollback("old output\nmore\n")
        buffer.feed("\u{1B}[H\u{1B}[2J")
        XCTAssertTrue(buffer.isEmpty)
    }

    // MARK: - Bounds

    func testScrollbackIsCappedAndKeepsTheNewestLines() {
        var buffer = TerminalScrollback()
        for index in 0..<(TerminalScrollback.maximumLines + 500) {
            buffer.feed("line \(index)\n")
        }
        let lines = buffer.lines
        XCTAssertLessThanOrEqual(lines.count, TerminalScrollback.maximumLines + 1)
        XCTAssertTrue(lines.contains { $0.text == "line 2499" })
        XCTAssertFalse(lines.contains { $0.text == "line 0" })
    }

    func testOneEndlessLineIsCapped() {
        var buffer = TerminalScrollback()
        buffer.feed(String(repeating: "x", count: 10_000))
        XCTAssertEqual(buffer.lines[0].text.count, TerminalScrollback.maximumColumns)
    }

    func testTrailingPaddingIsTrimmed() {
        let buffer = scrollback("done" + String(repeating: " ", count: 40))
        XCTAssertEqual(buffer.lines[0].text, "done")
    }

    // MARK: - Line endings

    /// A PTY always terminates lines with CRLF, and Swift folds CRLF into ONE
    /// Character: iterating a String hands over "\r\n" as a single grapheme
    /// cluster matching neither "\r" nor "\n". Before that was handled, every
    /// line of real output ran onto row 0 and the panel rendered one endless
    /// line. This is the exact opening a zsh login shell sends.
    func testCarriageReturnLineFeedStartsANewRow() {
        var buffer = TerminalScrollback()
        buffer.feed("\u{1B}[mdirenv: loading ~/projects/opensession/.envrc\r\n")
        buffer.feed("Setting up GStreamer environment...\r\nCould not find gstreamer\r\n")
        buffer.feed(
            "\r\u{1B}[0m\u{1B}[J\u{1B}[36mprojects/opensession\u{1B}[39m "
                + "\u{1B}[33mmain\u{1B}[39m> \u{1B}[K"
        )
        XCTAssertEqual(
            buffer.lines.map(\.text),
            [
                "direnv: loading ~/projects/opensession/.envrc",
                "Setting up GStreamer environment...",
                "Could not find gstreamer",
                "projects/opensession main>",
            ]
        )
    }

    /// A chunk boundary that falls between the CR and the LF must still be
    /// one line break, not two.
    func testCarriageReturnAndLineFeedSplitAcrossChunks() {
        var buffer = TerminalScrollback()
        buffer.feed("first\r")
        buffer.feed("\nsecond")
        XCTAssertEqual(buffer.lines.map(\.text), ["first", "second"])
    }

    // MARK: - Notices

    func testNoticeLandsOnItsOwnLine() {
        var buffer = TerminalScrollback()
        buffer.feed("output with no trailing newline")
        buffer.appendNotice("Session ended", style: TerminalStyle(ink: .indexed(1)))
        XCTAssertEqual(
            buffer.lines.map(\.text),
            ["output with no trailing newline", "Session ended", ""]
        )
    }
}
