import Foundation
import Observation

/// One open session: owns the WebSocket, holds the transcript, live stream
/// text, run state, and any pending question.
@Observable
@MainActor
final class SessionViewModel {
    enum ConnectionState: Equatable {
        case connecting
        case connected
        case reconnecting(String?)
    }

    let session: Session

    private(set) var entries: [TranscriptEntry] = []
    private(set) var liveText = ""
    private(set) var isStreaming = false
    private(set) var isRunning: Bool
    private(set) var queuedCount = 0
    private(set) var pendingQuestion: AskQuestion?
    private(set) var connectionState: ConnectionState = .connecting
    private(set) var notice: String?
    var draft = ""

    private var socket: OS1Socket?
    private var reconnectTask: Task<Void, Never>?
    private var stopped = false
    /// stream_done arrived; the durable entry lands via the next transcript_append.
    private var streamEnded = true
    /// Optimistic local user messages, removed once the server echoes them back.
    private var localEchoIds: Set<String> = []

    init(session: Session) {
        self.session = session
        self.isRunning = session.isRunning ?? false
        self.queuedCount = session.queuedCount ?? 0
    }

    func start() {
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        reconnectTask?.cancel()
        socket?.disconnect()
        socket = nil
    }

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && connectionState == .connected
    }

    func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let socket else { return }
        draft = ""
        let localId = "local-\(UUID().uuidString)"
        localEchoIds.insert(localId)
        entries.append(TranscriptEntry(
            id: localId,
            type: "user",
            content: text,
            timestamp: ISO8601DateFormatter().string(from: .now)
        ))
        socket.prompt(sessionId: session.id, content: text, user: ServerConfig.shared.userName)
    }

    func answer(question: AskQuestion, answers: [String: String]?) {
        socket?.answer(sessionId: session.id, questionId: question.id, answers: answers)
        pendingQuestion = nil
    }

    func cancelRun() {
        socket?.cancelWatchedRun()
    }

    // MARK: - Socket lifecycle

    private func connect() {
        connectionState = entries.isEmpty ? .connecting : .reconnecting(nil)
        let socket = OS1Socket()
        socket.onEvent = { [weak self] event in self?.handle(event) }
        socket.onClose = { [weak self] reason in self?.scheduleReconnect(reason) }
        self.socket = socket
        socket.connect()
    }

    private func scheduleReconnect(_ reason: String?) {
        guard !stopped else { return }
        connectionState = .reconnecting(reason)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !self.stopped, !Task.isCancelled else { return }
            self.connect()
        }
    }

    // MARK: - Event handling

    private func handle(_ event: ServerEvent) {
        switch event {
        case .hello:
            connectionState = .connected
            // Watch after the handshake frame so the send cannot race the upgrade.
            socket?.watch(sessionId: session.id)

        case .transcriptInit(let id, let newEntries) where id == session.id:
            entries = newEntries
            localEchoIds.removeAll()

        case .transcriptHistory(let id, let older) where id == session.id:
            let known = Set(entries.map(\.id))
            entries.insert(contentsOf: older.filter { !known.contains($0.id) }, at: 0)

        case .transcriptAppend(let id, let appended) where id == session.id:
            upsert(appended)
            if streamEnded {
                liveText = ""
                isStreaming = false
            }

        case .streamStart(let id) where id == session.id:
            liveText = ""
            isStreaming = true
            streamEnded = false

        case .streamText(let id, let text) where id == session.id:
            isStreaming = true
            liveText += text

        case .streamEntry(let id, let entry) where id == session.id:
            upsert([entry])

        case .streamDone(let id) where id == session.id:
            streamEnded = true

        case .sessionStatus(let id, let running) where id == session.id:
            isRunning = running
            if !running {
                streamEnded = true
                liveText = ""
                isStreaming = false
            }

        case .queueUpdate(let id, let count) where id == session.id:
            queuedCount = count

        case .askQuestion(let id, let question) where id == session.id:
            pendingQuestion = question

        case .askResolved(let id, let questionId) where id == session.id:
            if pendingQuestion?.id == questionId { pendingQuestion = nil }

        case .notice(let message), .serverError(let message):
            notice = message.isEmpty ? nil : message

        default:
            break
        }
    }

    private func upsert(_ incoming: [TranscriptEntry]) {
        for entry in incoming {
            if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                entries[index] = entry
            } else {
                // Drop the optimistic copy once the server's own user entry arrives.
                if entry.isUser, let localIndex = entries.firstIndex(where: {
                    localEchoIds.contains($0.id) && $0.content == entry.content
                }) {
                    localEchoIds.remove(entries[localIndex].id)
                    entries.remove(at: localIndex)
                }
                entries.append(entry)
            }
        }
    }
}
