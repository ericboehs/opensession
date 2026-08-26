import Foundation

/// One character cell's appearance, and the only part of ANSI this keeps.
///
/// Foreground colour, bold and dim are what make ordinary command output
/// readable: a compiler's red errors, a test runner's green dots, a prompt's
/// bright directory. Backgrounds, inverse, underline and blink are parsed and
/// dropped rather than rendered. They exist to paint a full-screen UI, and
/// this surface is a log, not a screen.
struct TerminalStyle: Equatable, Hashable, Sendable {
    /// Either a slot in the xterm palette (the view owns the actual hues, so
    /// they can differ per appearance) or a literal 24-bit colour.
    enum Ink: Equatable, Hashable, Sendable {
        case indexed(Int)
        case rgb(r: Int, g: Int, b: Int)
    }

    var ink: Ink?
    var bold = false
    var dim = false

    static let plain = TerminalStyle()
}

/// A stretch of characters sharing one appearance.
struct TerminalRun: Equatable, Sendable {
    var text: String
    var style: TerminalStyle
}

/// One finished line of output, identified so a lazy stack can keep its rows.
struct TerminalLine: Identifiable, Equatable, Sendable {
    let id: Int
    var runs: [TerminalRun]

    /// The line with every escape already gone: what a copy or a test reads.
    var text: String { runs.map(\.text).joined() }
}

/// A PTY's output, accumulated as lines a list can draw.
///
/// Deliberately not a terminal emulator. It is a cursor that can move along
/// the CURRENT line and nowhere else, which is exactly the subset real command
/// output uses: `\r` to redraw a progress bar in place, `\b` to rub out a
/// character, `ESC[K` to clear the rest of the line, SGR to colour a word.
/// Absolute cursor addressing, scroll regions and alternate screens are
/// recognised only well enough to be discarded. A full-screen program (vim,
/// htop) will look wrong here, and that is the honest outcome for a surface
/// whose input is one line of text.
///
/// The parser is a resumable state machine, so an escape sequence split
/// across two WebSocket frames still parses. Everything is value-typed and
/// free of UI, which is what lets `TerminalScrollbackTests` drive it directly.
struct TerminalScrollback: Sendable {
    /// How many lines to keep. A dev server left running overnight must not
    /// grow the app's memory without bound; 2,000 lines is far more than a
    /// phone screen can show and costs well under a megabyte.
    static let maximumLines = 2_000
    /// Longest line kept. Guards against a program that writes megabytes with
    /// no newline (a `cat` of a minified bundle) turning one row into a
    /// layout stall.
    static let maximumColumns = 4_000

    private struct Cell: Equatable {
        var character: Character
        var style: TerminalStyle
    }

    private struct Row {
        let id: Int
        var cells: [Cell]
    }

    private enum ParserState {
        case ground
        /// Saw ESC, waiting to learn what kind of sequence this is.
        case escape
        /// Inside `ESC [ … final`, accumulating parameter bytes.
        case controlSequence(parameters: String)
        /// Inside `ESC ] … BEL` or `… ESC \`: a window title, dropped whole.
        case operatingSystemCommand(sawEscape: Bool)
        /// A two-byte sequence whose second byte carries no meaning here.
        case discardOne
    }

    private var rows: [Row]
    private var nextRowId: Int
    private var column = 0
    private var style = TerminalStyle.plain
    private var state = ParserState.ground

    init() {
        rows = [Row(id: 0, cells: [])]
        nextRowId = 1
    }

    /// Every line, oldest first, with runs coalesced for rendering.
    var lines: [TerminalLine] {
        rows.map { row in
            TerminalLine(id: row.id, runs: TerminalScrollback.runs(of: row.cells))
        }
    }

    /// The whole buffer as plain text: what "copy all" and tests read.
    var plainText: String {
        rows.map { String($0.cells.map(\.character)) }.joined(separator: "\n")
    }

    var isEmpty: Bool { rows.count == 1 && rows[0].cells.isEmpty }

    // MARK: - Feeding

    /// Consume one chunk of PTY output. Safe to call with a chunk that ends
    /// mid-escape: the parser resumes on the next call.
    mutating func feed(_ chunk: String) {
        for character in chunk {
            switch state {
            case .ground:
                consumeGround(character)
            case .escape:
                consumeEscape(character)
            case .controlSequence(let parameters):
                consumeControlSequence(character, parameters: parameters)
            case .operatingSystemCommand(let sawEscape):
                consumeOperatingSystemCommand(character, sawEscape: sawEscape)
            case .discardOne:
                state = .ground
            }
        }
    }

    /// Append text that did not come from the PTY (a local notice, an
    /// exit line) in a style the caller picks.
    mutating func appendNotice(_ text: String, style noticeStyle: TerminalStyle) {
        if !rows[rows.count - 1].cells.isEmpty { newLine() }
        let previous = style
        style = noticeStyle
        for character in text where !character.isNewline { put(character) }
        style = previous
        newLine()
    }

    mutating func clear() {
        rows = [Row(id: nextRowId, cells: [])]
        nextRowId += 1
        column = 0
    }

    // MARK: - Parser states

    private mutating func consumeGround(_ character: Character) {
        switch character {
        case "\u{1B}":
            state = .escape
        case "\r\n":
            // Swift folds CRLF into ONE Character: iterating a String hands
            // over "\r\n" as a single grapheme cluster, which matches neither
            // "\r" nor "\n". Without this case every line of a PTY's output
            // (a PTY always writes CRLF) ran onto the same row, and the whole
            // scrollback rendered as one endless line.
            newLine()
        case "\n":
            newLine()
        case "\r":
            column = 0
        case "\u{08}":
            column = max(0, column - 1)
        case "\t":
            // Tab stops every 8 columns, materialised as spaces: the view
            // draws a proportional-safe monospaced font, not a grid, so a
            // real tab would land wherever the layout felt like.
            let target = min((column / 8 + 1) * 8, TerminalScrollback.maximumColumns)
            while column < target { put(" ") }
        case "\u{07}":
            break // bell
        default:
            // Remaining C0 controls carry no meaning for a log.
            if let ascii = character.asciiValue, ascii < 0x20 { break }
            put(character)
        }
    }

    private mutating func consumeEscape(_ character: Character) {
        switch character {
        case "[":
            state = .controlSequence(parameters: "")
        case "]":
            state = .operatingSystemCommand(sawEscape: false)
        case "(", ")", "#", "%":
            state = .discardOne // charset designation
        default:
            state = .ground
        }
    }

    private mutating func consumeControlSequence(_ character: Character, parameters: String) {
        // Parameter and intermediate bytes run 0x20–0x3F; the first byte in
        // 0x40–0x7E ends the sequence and says what it was.
        if let ascii = character.asciiValue, (0x40...0x7E).contains(ascii) {
            state = .ground
            apply(final: character, parameters: parameters)
            return
        }
        // A runaway sequence (a stray ESC[ in binary output) must not grow
        // forever. 64 bytes is far past any real sequence.
        guard parameters.count < 64 else {
            state = .ground
            return
        }
        state = .controlSequence(parameters: parameters + String(character))
    }

    private mutating func consumeOperatingSystemCommand(_ character: Character, sawEscape: Bool) {
        if character == "\u{07}" || (sawEscape && character == "\\") {
            state = .ground
            return
        }
        state = .operatingSystemCommand(sawEscape: character == "\u{1B}")
    }

    // MARK: - Control sequences

    private mutating func apply(final: Character, parameters: String) {
        // Private sequences (`ESC[?25l` and friends: cursor visibility, the
        // alternate screen, bracketed paste) change nothing a log can show.
        guard !parameters.hasPrefix("?") else { return }
        let numbers = parameters
            .split(separator: ";", omittingEmptySubsequences: false)
            .map { Int($0) ?? 0 }

        switch final {
        case "m":
            applyGraphicRendition(numbers)
        case "K":
            switch numbers.first ?? 0 {
            case 1:
                blankThroughCursor()
            case 2:
                rows[rows.count - 1].cells = []
            default:
                truncateAtCursor()
            }
        case "J":
            // A screen clear is the one whole-buffer gesture worth honouring:
            // someone typed `clear`, and the point of typing it is an empty
            // view.
            if (numbers.first ?? 0) >= 2 { clear() } else { truncateAtCursor() }
        case "C":
            let distance = max(1, numbers.first ?? 1)
            let target = min(column + distance, TerminalScrollback.maximumColumns)
            while column < target { put(" ") }
        case "D":
            column = max(0, column - max(1, numbers.first ?? 1))
        case "G":
            column = max(0, (numbers.first ?? 1) - 1)
        default:
            // Cursor addressing, scrolling, insert/delete: dropped. See the
            // type's note on why this is not an emulator.
            break
        }
    }

    private mutating func applyGraphicRendition(_ numbers: [Int]) {
        // A bare `ESC[m` is a reset.
        guard !numbers.isEmpty else {
            style = .plain
            return
        }
        var index = 0
        while index < numbers.count {
            let code = numbers[index]
            switch code {
            case 0:
                style = .plain
            case 1:
                style.bold = true
            case 2:
                style.dim = true
            case 22:
                style.bold = false
                style.dim = false
            case 30...37:
                style.ink = .indexed(code - 30)
            case 90...97:
                style.ink = .indexed(code - 90 + 8)
            case 39:
                style.ink = nil
            case 38:
                // `38;5;n` (palette) or `38;2;r;g;b` (direct colour).
                if index + 2 < numbers.count, numbers[index + 1] == 5 {
                    style.ink = .indexed(numbers[index + 2])
                    index += 2
                } else if index + 4 < numbers.count, numbers[index + 1] == 2 {
                    style.ink = .rgb(
                        r: numbers[index + 2], g: numbers[index + 3], b: numbers[index + 4]
                    )
                    index += 4
                }
            case 48:
                // Backgrounds are dropped, but their parameters still have to
                // be stepped over or the colour numbers read as more codes.
                if index + 2 < numbers.count, numbers[index + 1] == 5 {
                    index += 2
                } else if index + 4 < numbers.count, numbers[index + 1] == 2 {
                    index += 4
                }
            default:
                break // underline, inverse, blink, backgrounds: parsed, dropped
            }
            index += 1
        }
    }

    // MARK: - Buffer edits

    private mutating func put(_ character: Character) {
        guard column < TerminalScrollback.maximumColumns else { return }
        let last = rows.count - 1
        if rows[last].cells.count <= column {
            // Padding a gap left by a cursor jump: the spaces are plain, so a
            // colour set before the jump does not bleed across the gap.
            while rows[last].cells.count < column {
                rows[last].cells.append(Cell(character: " ", style: .plain))
            }
            rows[last].cells.append(Cell(character: character, style: style))
        } else {
            rows[last].cells[column] = Cell(character: character, style: style)
        }
        column += 1
    }

    private mutating func newLine() {
        rows.append(Row(id: nextRowId, cells: []))
        nextRowId += 1
        column = 0
        if rows.count > TerminalScrollback.maximumLines {
            rows.removeFirst(rows.count - TerminalScrollback.maximumLines)
        }
    }

    private mutating func truncateAtCursor() {
        let last = rows.count - 1
        if rows[last].cells.count > column {
            rows[last].cells.removeSubrange(column...)
        }
    }

    private mutating func blankThroughCursor() {
        let last = rows.count - 1
        let end = min(column, rows[last].cells.count - 1)
        guard end >= 0 else { return }
        for index in 0...end {
            rows[last].cells[index] = Cell(character: " ", style: .plain)
        }
    }

    // MARK: - Rendering

    /// Coalesce cells into the fewest runs that still carry every style, and
    /// drop trailing whitespace. A PTY pads lines it has redrawn, and the
    /// padding would otherwise defeat the view's text selection.
    private static func runs(of cells: [Cell]) -> [TerminalRun] {
        var end = cells.count
        while end > 0, cells[end - 1].character == " ", cells[end - 1].style == .plain {
            end -= 1
        }
        guard end > 0 else { return [] }

        var runs: [TerminalRun] = []
        var text = ""
        var current = cells[0].style
        for index in 0..<end {
            let cell = cells[index]
            if cell.style != current {
                runs.append(TerminalRun(text: text, style: current))
                text = ""
                current = cell.style
            }
            text.append(cell.character)
        }
        if !text.isEmpty { runs.append(TerminalRun(text: text, style: current)) }
        return runs
    }
}
