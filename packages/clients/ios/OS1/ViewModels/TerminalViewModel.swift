import Foundation

/// The state behind the session's terminal panel: one shell, its output, and
/// whether it is still alive.
///
/// The shape of this deliberately is not a terminal emulator's. The server can
/// only ever hand a client a FRESH pty (`term_start` in
/// `src/server/terminals.ts` allocates one per socket and terminal id; nothing
/// attaches to an existing shell, and the agent's own tool calls never run in
/// one). So "watch what the session is doing" is not on offer at any price.
/// What is on offer is a shell in the session's worktree, which is enough to
/// run a command and read the answer, and enough to follow something live if
/// you point it at one (`tail -f`, `docker logs -f`, a dev server started from
/// here). This class is built for that: a log that streams, and one line of
/// input.
@MainActor
@Observable
final class TerminalViewModel {
    enum State: Equatable {
        case connecting
        /// The shell is live. `target` is where it landed (host, docker,
        /// daytona…) and `cwd` the directory it opened in.
        case running(target: String, cwd: String)
        case ended(code: Int)
        case failed(reason: String)
    }

    private(set) var state = State.connecting
    /// Every line of output. Read by the view's list; updated at most ~8 times
    /// a second however fast the shell writes (see `scheduleFlush`).
    private(set) var lines: [TerminalLine] = []
    /// Whether the user has scrolled away from the tail. Owned here so the
    /// scroll-to-bottom control and the follow behaviour agree.
    var isPinnedToBottom = true
    /// Output arrived while the view was scrolled up: what turns the
    /// scroll-to-bottom control into a notification.
    var hasUnseenOutput = false

    let sessionId: String
    private let socket: any SessionTerminalSocket
    private var scrollback = TerminalScrollback()
    /// Bytes of a multi-byte character split across two frames.
    private var undecodedTail = Data()
    private var flushTask: Task<Void, Never>?
    private var columns = 80
    private var hasStarted = false

    /// Commands the user has run, newest last: what the recents menu offers.
    private(set) var history: [String] = []

    init(sessionId: String, socket: (any SessionTerminalSocket)? = nil) {
        self.sessionId = sessionId
        self.socket = socket ?? TerminalSocket()
        self.socket.onEvent = { [weak self] event in self?.handle(event) }
        self.socket.onClose = { [weak self] reason in self?.handleClose(reason) }
    }

    // MARK: - Lifecycle

    /// Open the shell. Idempotent, and safe to call before or after the view
    /// has measured itself: SwiftUI does not promise whether `onAppear` or the
    /// first geometry reading comes first, and a version of this that keyed
    /// "have we started" off the measured width simply never opened a shell
    /// when the measurement won the race.
    func start(columns: Int? = nil) {
        guard !hasStarted else { return }
        hasStarted = true
        if let columns { self.columns = TerminalViewModel.clampColumns(columns) }
        socket.connect()
        socket.start(sessionId: sessionId, columns: self.columns, rows: 40)
    }

    func stop() {
        flushTask?.cancel()
        flushTask = nil
        socket.disconnect()
    }

    /// Whether there is a shell to type at.
    var isLive: Bool {
        if case .running = state { return true }
        return false
    }

    /// Open a fresh shell after the last one exited or the connection went.
    ///
    /// A NEW pty, never the old one: the server ties a shell's life to the
    /// socket that asked for it, so whatever ended it is already gone. The
    /// scrollback stays, because what a shell printed on its way out is
    /// usually the reason anyone is looking. Without this the panel is a dead
    /// end on a dropped connection, with a disabled field and no way back
    /// except leaving and coming in again.
    func restart() {
        guard !isLive else { return }
        hasStarted = false
        undecodedTail = Data()
        state = .connecting
        scrollback.appendNotice(
            "Starting a new shell",
            style: TerminalStyle(ink: .indexed(4), dim: true)
        )
        lines = scrollback.lines
        start()
    }

    /// The shell wraps its output at whatever width it believes it has, so a
    /// rotation has to be told. Nothing else about geometry is negotiated.
    /// A width measured before the shell opened is simply remembered, and
    /// becomes the width it opens with.
    func setColumns(_ requested: Int) {
        let clamped = TerminalViewModel.clampColumns(requested)
        guard clamped != columns else { return }
        columns = clamped
        guard hasStarted else { return }
        socket.resize(columns: clamped, rows: 40)
    }

    /// Run one command. The shell echoes it back, which is what puts it in the
    /// scrollback, the same way it would look in a terminal.
    func run(_ command: String) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, case .running = state else { return }
        history.removeAll { $0 == trimmed }
        history.append(trimmed)
        if history.count > 50 { history.removeFirst(history.count - 50) }
        socket.send(input: trimmed + "\n")
        // Sending is the one gesture that always returns to the tail: you
        // asked for output, so you are looking for it.
        isPinnedToBottom = true
        hasUnseenOutput = false
    }

    /// Interrupt whatever is running, the way ^C does. The single control the
    /// field keeps, because starting something endless (`tail -f`, a dev
    /// server) is the normal case here and there would otherwise be no way
    /// back short of closing the panel.
    func interrupt() {
        guard case .running = state else { return }
        socket.send(input: "\u{03}")
        isPinnedToBottom = true
    }

    func clear() {
        scrollback.clear()
        lines = scrollback.lines
        hasUnseenOutput = false
    }

    /// The whole buffer, for a share sheet or a copy.
    var plainText: String { scrollback.plainText }

    // MARK: - Frames

    private func handle(_ event: ServerEvent) {
        switch event {
        case .terminalReady(let termId, let target, let cwd):
            guard termId == TerminalSocket.terminalId else { return }
            state = .running(target: target, cwd: cwd)
        case .terminalData(let termId, let data):
            guard termId == TerminalSocket.terminalId else { return }
            append(data)
        case .terminalNotice(let termId, let message):
            guard termId == TerminalSocket.terminalId else { return }
            scrollback.appendNotice(message, style: TerminalStyle(ink: .indexed(3), dim: true))
            scheduleFlush()
        case .terminalExit(let termId, let code):
            guard termId == TerminalSocket.terminalId else { return }
            finishStream()
            scrollback.appendNotice(
                code == 0 ? "Shell closed." : "Shell closed (exit \(code)).",
                style: TerminalStyle(ink: .indexed(1))
            )
            lines = scrollback.lines
            state = .ended(code: code)
        case .serverError(let message):
            state = .failed(reason: message)
        default:
            // Every other frame on this socket, including anything the
            // server learns to send later, is not this panel's business.
            break
        }
    }

    private func handleClose(_ reason: String?) {
        finishStream()
        guard case .running = state else {
            if case .connecting = state {
                state = .failed(reason: reason ?? "Could not open a shell")
            }
            return
        }
        if let reason {
            scrollback.appendNotice(reason, style: TerminalStyle(ink: .indexed(1)))
            lines = scrollback.lines
            state = .failed(reason: reason)
        } else {
            state = .ended(code: 0)
        }
    }

    private func append(_ data: Data) {
        let (text, remainder) = TerminalViewModel.decodeLongestValidPrefix(undecodedTail + data)
        undecodedTail = remainder
        guard !text.isEmpty else { return }
        scrollback.feed(text)
        scheduleFlush()
    }

    /// Publish the buffer at ~8Hz rather than per frame.
    ///
    /// A build or a dev server emits hundreds of small writes a second, and
    /// every publish re-evaluates the list's body. This is the same coalescing
    /// the transcript's streaming text uses, and for the same reason.
    private func scheduleFlush() {
        if !isPinnedToBottom { hasUnseenOutput = true }
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self, !Task.isCancelled else { return }
            self.flushTask = nil
            self.lines = self.scrollback.lines
        }
    }

    private func finishStream() {
        flushTask?.cancel()
        flushTask = nil
        // Anything left in the tail was a truncated character; showing it as a
        // replacement mark beats dropping the line it sat on.
        if !undecodedTail.isEmpty {
            scrollback.feed(String(decoding: undecodedTail, as: UTF8.self))
            undecodedTail = Data()
        }
        lines = scrollback.lines
    }

    // MARK: - Helpers

    /// The server clamps to 20…500; this narrows it to widths a phone can
    /// actually render without either wrapping every line or hiding output
    /// off the right edge.
    static func clampColumns(_ requested: Int) -> Int {
        min(200, max(30, requested))
    }

    /// Split a byte run at the last complete UTF-8 character.
    ///
    /// pty output is bytes and a WebSocket frame can land in the middle of a
    /// multi-byte character, and decoding each frame on its own turns an accented
    /// letter or an emoji into two replacement marks. The remainder is carried
    /// into the next frame.
    static func decodeLongestValidPrefix(_ data: Data) -> (text: String, remainder: Data) {
        guard !data.isEmpty else { return ("", Data()) }
        // A UTF-8 character is at most four bytes, so a valid prefix is within
        // three bytes of the end.
        for backoff in 0...min(3, data.count) {
            let split = data.count - backoff
            if let text = String(data: data.prefix(split), encoding: .utf8) {
                return (text, data.suffix(from: data.startIndex + split))
            }
        }
        // Genuinely invalid bytes (a binary file catted into the shell):
        // decode lossily rather than stalling the stream forever.
        return (String(decoding: data, as: UTF8.self), Data())
    }
}
