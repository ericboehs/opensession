import XCTest
@testable import OS1

/// A scripted stand-in for a shell: records what the client sent, and lets a
/// test play frames back as the server would.
@MainActor
private final class FakeTerminalSocket: SessionTerminalSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    private(set) var connected = false
    private(set) var disconnected = false
    private(set) var startedWith: (sessionId: String, columns: Int)?
    private(set) var startCount = 0
    private(set) var sent: [String] = []
    private(set) var resizes: [Int] = []

    func connect() { connected = true }
    func disconnect() { disconnected = true }
    func start(sessionId: String, columns: Int, rows: Int) {
        startedWith = (sessionId, columns)
        startCount += 1
    }
    func send(input: String) { sent.append(input) }
    func resize(columns: Int, rows: Int) { resizes.append(columns) }

    /// Output, the way the server sends it: base64 of raw pty bytes.
    func emit(_ text: String) {
        onEvent?(.terminalData(termId: TerminalSocket.terminalId, data: Data(text.utf8)))
    }
    func emitBytes(_ bytes: [UInt8]) {
        onEvent?(.terminalData(termId: TerminalSocket.terminalId, data: Data(bytes)))
    }
    func ready(target: String = "host", cwd: String = "/w") {
        onEvent?(.terminalReady(termId: TerminalSocket.terminalId, target: target, cwd: cwd))
    }
}

@MainActor
final class TerminalViewModelTests: XCTestCase {
    private func makeModel() -> (TerminalViewModel, FakeTerminalSocket) {
        let socket = FakeTerminalSocket()
        return (TerminalViewModel(sessionId: "os-1", socket: socket), socket)
    }

    /// Output is published on a timer rather than per frame, so tests wait for
    /// one flush rather than reading `lines` straight after feeding.
    private func waitForFlush() async {
        try? await Task.sleep(for: .milliseconds(220))
    }

    func testStartOpensAShellForTheSession() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        XCTAssertTrue(socket.connected)
        XCTAssertEqual(socket.startedWith?.sessionId, "os-1")
        XCTAssertEqual(socket.startedWith?.columns, 80)
    }

    func testReadyReportsWhereTheShellLanded() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready(target: "docker", cwd: "/workspace")
        XCTAssertEqual(model.state, .running(target: "docker", cwd: "/workspace"))
    }

    func testOutputBecomesLines() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        socket.emit("hello\nworld\n")
        await waitForFlush()
        XCTAssertEqual(model.lines.map(\.text), ["hello", "world", ""])
    }

    func testRunSendsTheCommandWithANewline() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        model.run("  bun test  ")
        XCTAssertEqual(socket.sent, ["bun test\n"])
        XCTAssertEqual(model.history, ["bun test"])
    }

    func testRunIsIgnoredBeforeTheShellIsReady() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        model.run("ls")
        XCTAssertTrue(socket.sent.isEmpty, "a command must not be sent into a shell that isn't up")
    }

    func testHistoryKeepsOneEntryPerCommandMostRecentLast() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        model.run("ls")
        model.run("pwd")
        model.run("ls")
        XCTAssertEqual(model.history, ["pwd", "ls"])
    }

    func testInterruptSendsControlC() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        model.interrupt()
        XCTAssertEqual(socket.sent, ["\u{03}"])
    }

    /// SwiftUI does not promise that `onAppear` runs before the first geometry
    /// reading. A width measured first must not stop the shell from opening,
    /// and must become the width it opens with.
    func testWidthMeasuredBeforeAppearStillOpensAShellAtThatWidth() {
        let (model, socket) = makeModel()
        model.setColumns(120)
        XCTAssertTrue(socket.resizes.isEmpty, "there is no shell to resize yet")
        model.start()
        XCTAssertEqual(socket.startedWith?.columns, 120)
        XCTAssertTrue(socket.connected)
    }

    func testStartIsIdempotent() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        model.start(columns: 80)
        XCTAssertEqual(socket.startCount, 1, "a redraw must not open a second shell")
    }

    func testResizeOnlyFiresWhenTheWidthActuallyChanges() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        model.setColumns(80)
        model.setColumns(100)
        model.setColumns(100)
        XCTAssertEqual(socket.resizes, [100])
    }

    func testColumnsAreClampedToWidthsAPhoneCanRender() {
        XCTAssertEqual(TerminalViewModel.clampColumns(4), 30)
        XCTAssertEqual(TerminalViewModel.clampColumns(9_000), 200)
    }

    func testExitClosesTheShellAndSaysSo() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        socket.emit("done\n")
        socket.onEvent?(.terminalExit(termId: TerminalSocket.terminalId, code: 130))
        XCTAssertEqual(model.state, .ended(code: 130))
        XCTAssertTrue(model.plainText.contains("Shell closed (exit 130)."))
    }

    func testFramesForAnotherTerminalAreIgnored() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        socket.onEvent?(.terminalData(termId: "someone-else", data: Data("noise\n".utf8)))
        await waitForFlush()
        XCTAssertFalse(model.plainText.contains("noise"))
    }

    func testUnknownFramesOnThisSocketAreHarmless() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        socket.onEvent?(.pong)
        socket.onEvent?(.presence(sessionId: "os-1", viewers: ["someone"]))
        XCTAssertEqual(model.state, .running(target: "host", cwd: "/w"))
    }

    func testScrollingUpStopsTheViewFollowingAndFlagsNewOutput() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        model.isPinnedToBottom = false
        socket.emit("more output\n")
        await waitForFlush()
        XCTAssertTrue(model.hasUnseenOutput)
    }

    func testSendingReturnsToTheTail() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        model.isPinnedToBottom = false
        model.hasUnseenOutput = true
        model.run("ls")
        XCTAssertTrue(model.isPinnedToBottom)
        XCTAssertFalse(model.hasUnseenOutput)
    }

    // MARK: - Byte decoding

    func testMultiByteCharacterSplitAcrossFramesIsNotMangled() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        // "é" is 0xC3 0xA9; the frame boundary lands between them.
        socket.emitBytes([0x63, 0x61, 0x66, 0xC3])
        socket.emitBytes([0xA9, 0x0A])
        await waitForFlush()
        XCTAssertEqual(model.lines.first?.text, "café")
    }

    func testDecodeSplitsAtTheLastCompleteCharacter() {
        let (text, remainder) = TerminalViewModel.decodeLongestValidPrefix(
            Data([0x68, 0x69, 0xE2, 0x9C])
        )
        XCTAssertEqual(text, "hi")
        XCTAssertEqual(remainder.count, 2, "the incomplete character is carried forward")
    }

    func testInvalidBytesDoNotStallTheStream() {
        let (text, remainder) = TerminalViewModel.decodeLongestValidPrefix(
            Data([0xFF, 0xFE, 0xFD, 0xFC, 0xFB])
        )
        XCTAssertFalse(text.isEmpty)
        XCTAssertTrue(remainder.isEmpty, "garbage must be dropped, not held forever")
    }

    func testClearEmptiesTheView() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        socket.emit("old\n")
        await waitForFlush()
        model.clear()
        XCTAssertEqual(model.plainText, "")
    }

    func testStopClosesTheSocket() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        model.stop()
        XCTAssertTrue(socket.disconnected, "leaving the panel must take the shell with it")
    }

    // MARK: - Recovering a dead shell

    func testRestartOpensANewShellAndKeepsTheOutput() async {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        socket.emit("the last thing it said\n")
        await waitForFlush()
        socket.onClose?("Connection lost")

        XCTAssertFalse(model.isLive)
        model.restart()

        XCTAssertEqual(socket.startCount, 2, "a dropped shell is replaced, not resumed")
        XCTAssertTrue(
            model.plainText.contains("the last thing it said"),
            "why the shell died is usually the reason someone is looking"
        )
    }

    func testRestartDoesNothingWhileTheShellIsAlive() {
        let (model, socket) = makeModel()
        model.start(columns: 80)
        socket.ready()
        model.restart()
        XCTAssertEqual(socket.startCount, 1, "a live shell must not be thrown away")
    }
}
