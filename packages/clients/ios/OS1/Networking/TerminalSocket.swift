import Foundation

/// The socket surface `TerminalViewModel` drives, so tests can substitute a
/// scripted double for a real shell.
@MainActor
protocol SessionTerminalSocket: AnyObject {
    var onEvent: ((ServerEvent) -> Void)? { get set }
    var onClose: ((String?) -> Void)? { get set }
    func connect()
    func disconnect()
    func start(sessionId: String, columns: Int, rows: Int)
    func send(input: String)
    func resize(columns: Int, rows: Int)
}

/// One WebSocket carrying one shell, for the session terminal panel.
///
/// A connection of its own rather than a rider on the session's watch socket,
/// because the server ties a shell's lifetime to the socket that asked for it
/// (`stopAllTerminals` on teardown, `src/server/terminals.ts`). Closing this
/// one closes the PTY; nothing has to remember to stop it, and no failure mode
/// leaves a shell running on the host after the panel is gone. It never sends
/// `watch`, so it adds no second face to the session for everyone else. The
/// transcript socket remains the only thing that claims presence.
///
/// What the server does NOT offer is worth stating here, because it decides
/// what this panel can be: `term_start` allocates a NEW pty every time. There
/// is no way to attach to a shell that already exists, and the agent's own
/// commands do not run in one, so a client cannot observe what the session is
/// already doing. It can only run its own commands and watch those.
@MainActor
final class TerminalSocket: SessionTerminalSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    /// This client's shell. The server keys shells by (socket, termId) and we
    /// only ever open one, so a constant is enough. Frames still carry it
    /// and the reader still checks it, so a future second shell cannot be
    /// crossed with this one.
    static let terminalId = "ios"

    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var closed = false
    /// The server greets a new socket with `hello`, and nothing sent before
    /// that greeting is reliably delivered: a frame written between `resume()`
    /// and the completed handshake is dropped on the floor, which showed up as
    /// a panel stuck on "Opening a shell…" with a healthy socket underneath
    /// and no error anywhere. So the open request waits here for the greeting.
    private var greeted = false
    private var pendingStart: [String: Any]?

    func connect() {
        guard let url = ServerConfig.shared.wsURL else {
            onClose?("Server URL not set")
            return
        }
        closed = false
        greeted = false
        let task = URLSession.shared.webSocketTask(with: ServerConfig.shared.authorizedRequest(url))
        // The default 1 MB cap is a receive() that THROWS, and on this socket
        // that would take the shell with it. Broadcast frames (presence and
        // the like) reach every client, not just watchers, so the ceiling is
        // not ours to predict: match the transcript socket's.
        task.maximumMessageSize = 32 * 1024 * 1024
        self.task = task
        task.resume()
        receiveTask = Task { [weak self] in await self?.receiveLoop(task) }
        keepAliveTask = Task { [weak self] in await self?.keepAliveLoop() }
    }

    func disconnect() {
        // Ask politely first so the shell dies with a `term_exit` the user can
        // see; dropping the socket would kill it just as surely, but silently.
        sendFrame(["type": "term_stop", "termId": TerminalSocket.terminalId])
        finish(reason: nil, notify: false)
    }

    func start(sessionId: String, columns: Int, rows: Int) {
        let frame: [String: Any] = [
            "type": "term_start",
            "sessionId": sessionId,
            "termId": TerminalSocket.terminalId,
            "cols": columns,
            "rows": rows,
        ]
        if greeted {
            sendFrame(frame)
        } else {
            pendingStart = frame
        }
    }

    /// Text typed at the shell. Base64 because the server hands the bytes
    /// straight to the pty.
    func send(input: String) {
        sendFrame([
            "type": "term_input",
            "termId": TerminalSocket.terminalId,
            "data": Data(input.utf8).base64EncodedString(),
        ])
    }

    /// The one piece of terminal negotiation this surface keeps: programs ask
    /// the pty how wide it is, and a shell that thinks it has 80 columns wraps
    /// its output at 80 whatever the phone is doing.
    func resize(columns: Int, rows: Int) {
        // Before the greeting there is no shell to resize, and the frame
        // would be dropped: fold the new size into the request still waiting
        // to go out, or the shell opens at whatever width was measured first.
        if pendingStart != nil {
            pendingStart?["cols"] = columns
            pendingStart?["rows"] = rows
            return
        }
        sendFrame([
            "type": "term_resize",
            "termId": TerminalSocket.terminalId,
            "cols": columns,
            "rows": rows,
        ])
    }

    private func sendFrame(_ frame: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { [weak self] error in
            if error != nil {
                Task { @MainActor in self?.finish(reason: "Send failed") }
            }
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !closed {
            do {
                let message = try await task.receive()
                let data: Data? = switch message {
                case .string(let text): Data(text.utf8)
                case .data(let raw): raw
                @unknown default: nil
                }
                guard let data else { continue }
                let event = ServerEvent.parse(data)
                if case .hello = event, !greeted {
                    greeted = true
                    if let frame = pendingStart {
                        pendingStart = nil
                        sendFrame(frame)
                    }
                }
                onEvent?(event)
            } catch {
                finish(reason: closed ? nil : "Connection lost")
                return
            }
        }
    }

    /// The server never pings, and a shell can sit idle for a long time
    /// between commands. A cheap ping keeps a NAT or proxy from quietly
    /// dropping the connection, and taking the shell with it.
    private func keepAliveLoop() async {
        while !closed {
            try? await Task.sleep(for: .seconds(25))
            if closed { return }
            sendFrame(["type": "ping"])
        }
    }

    private func finish(reason: String?, notify: Bool = true) {
        guard !closed else { return }
        closed = true
        pendingStart = nil
        receiveTask?.cancel()
        keepAliveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if notify { onClose?(reason) }
    }
}
