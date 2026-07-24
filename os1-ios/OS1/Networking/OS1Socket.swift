import Foundation

/// One WebSocket connection to the OpenSession server (`/ws`), authenticated
/// with the bearer token on the upgrade request.
///
/// The server never pings; clients are expected to send `{"type":"ping"}` and
/// treat a missed pong as a dead socket (half-open iOS sockets are the reason
/// this exists). Reconnect policy lives in the owner — on failure this class
/// reports `onClose` once and stops.
@MainActor
final class OS1Socket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var lastPong = Date()
    private var closed = false

    func connect() {
        guard let url = ServerConfig.shared.wsURL else {
            onClose?("Server URL not set")
            return
        }
        closed = false
        lastPong = Date()
        let request = ServerConfig.shared.authorizedRequest(url)
        let task = URLSession.shared.webSocketTask(with: request)
        // Default cap is 1 MB — a heavy session's transcript_init chunk (up
        // to ~120 entries × 32 KB wire clamp) blows past it, receive() throws,
        // and the watcher loops "Connection lost → reconnect" on that one
        // session forever. Match the web client, which has no such cap.
        task.maximumMessageSize = 32 * 1024 * 1024
        self.task = task
        task.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
        pingTask = Task { [weak self] in
            await self?.pingLoop()
        }
    }

    func disconnect() {
        finish(reason: nil, notify: false)
    }

    // MARK: - Outgoing frames

    func watch(sessionId: String) {
        send(["type": "watch", "sessionId": sessionId])
    }

    /// Page one window of earlier history (arrives as transcript_history).
    /// `beforeRev` guards against the mirror file rotating under the cursor —
    /// on mismatch the server re-sends a fresh transcript_init instead.
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {
        var frame: [String: Any] = [
            "type": "load_history", "sessionId": sessionId, "beforeOffset": beforeOffset,
        ]
        if let beforeRev { frame["beforeRev"] = beforeRev }
        send(frame)
    }

    /// Seq-mode paging for sessions served from the transcript v2 store.
    func loadHistory(sessionId: String, beforeSeq: Int) {
        send(["type": "load_history", "sessionId": sessionId, "beforeSeq": beforeSeq])
    }

    func prompt(sessionId: String, content: String, user: String) {
        // busyMode "queue" matches the web composer's default: a send during
        // a run is held as an editable queued message (visible as a chip)
        // until the run completes; steering it sooner is an explicit action.
        send([
            "type": "prompt", "sessionId": sessionId, "content": content,
            "user": user, "busyMode": "queue",
        ])
    }

    /// Deliver a queued message at the run's next turn boundary instead of
    /// waiting for it to finish.
    func steerQueued(sessionId: String, queueId: String) {
        send(["type": "steer_queued_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    func deleteQueued(sessionId: String, queueId: String) {
        send(["type": "delete_queued_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    func cancelWatchedRun() {
        // The server stops the run of the session this socket is watching.
        send(["type": "cancel"])
    }

    func answer(sessionId: String, questionId: String, answers: [String: String]?) {
        var frame: [String: Any] = ["type": "answer_question", "sessionId": sessionId, "questionId": questionId]
        frame["answers"] = answers ?? NSNull()
        send(frame)
    }

    private func send(_ frame: [String: Any]) {
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

    // MARK: - Loops

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
                // Any inbound frame proves the socket is alive — during a
                // heavy stream the server may not answer pings promptly, and
                // stream frames are just as good a liveness signal.
                lastPong = Date()
                onEvent?(event)
            } catch {
                finish(reason: closed ? nil : "Connection lost")
                return
            }
        }
    }

    private func pingLoop() async {
        // 10s cadence / 30s deadline: a half-open socket (backgrounded app,
        // wifi→cellular switch) is detected within ~40s even if receive()
        // never throws. The old 20s/65s pair left the transcript silently
        // stale for up to ~85s.
        while !closed {
            try? await Task.sleep(for: .seconds(10))
            if closed { return }
            if Date().timeIntervalSince(lastPong) > 30 {
                finish(reason: "Connection timed out")
                return
            }
            send(["type": "ping"])
        }
    }

    private func finish(reason: String?, notify: Bool = true) {
        guard !closed else { return }
        closed = true
        receiveTask?.cancel()
        pingTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if notify { onClose?(reason) }
    }
}
