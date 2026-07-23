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
    /// Ephemeral entries from the live engine stream (tool calls mid-run).
    /// They render at the end in stream order and graduate into `entries`
    /// when the file watcher lands them via transcript_append — the
    /// transcript FILE is the order authority. (Appending stream entries to
    /// `entries` directly put tool calls ahead of the assistant text that
    /// precedes them in the file, because that text lands ~1s later.)
    private(set) var liveEntries: [TranscriptEntry] = []
    private(set) var liveText = ""
    private(set) var isStreaming = false
    private(set) var isRunning: Bool
    private(set) var queuedCount = 0
    /// Messages held for after the current run (editable, steerable).
    private(set) var queuedItems: [QueueItem] = []
    /// Steer receipts: delivering into the run at its next turn boundary.
    private(set) var steeredItems: [QueueItem] = []
    private(set) var pendingQuestion: AskQuestion?
    private(set) var connectionState: ConnectionState = .connecting
    private(set) var notice: String?
    var draft = ""

    private var socket: OS1Socket?
    private var reconnectTask: Task<Void, Never>?
    /// Foreground liveness probe (see `appDidBecomeActive`).
    private var resyncProbeTask: Task<Void, Never>?
    /// When the last server frame arrived — any frame counts.
    private var lastEventAt = Date.distantPast
    private var stopped = false
    /// stream_done arrived; the durable entry lands via the next transcript_append.
    private var streamEnded = true
    /// Optimistic local user messages, removed once the server echoes them back.
    private var localEchoIds: Set<String> = []
    /// Assistant blocks that already landed as transcript entries. Opencode
    /// streams whole completed blocks, and the durable entry can beat the
    /// stream_text broadcast (or vice versa) — without this the same text
    /// shows twice: in the transcript AND in the live bubble. Mirrors the
    /// web viewer's landedStreamTextRef.
    private var landedStreamTexts: [String] = []
    /// Stream text is coalesced here and flushed to `liveText` at ~8Hz:
    /// every liveText change re-parses the whole bubble's markdown and
    /// re-anchors the scroll view, so per-chunk updates burn a full layout
    /// pass each on fast streams.
    private var pendingLiveText = ""
    private var liveFlushTask: Task<Void, Never>?

    private func appendLiveText(_ text: String) {
        pendingLiveText += text
        guard liveFlushTask == nil else { return }
        liveFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self, !Task.isCancelled else { return }
            self.liveFlushTask = nil
            if !self.pendingLiveText.isEmpty {
                self.liveText += self.pendingLiveText
                self.pendingLiveText = ""
            }
        }
    }

    private func flushLiveTextNow() {
        liveFlushTask?.cancel()
        liveFlushTask = nil
        if !pendingLiveText.isEmpty {
            liveText += pendingLiveText
            pendingLiveText = ""
        }
    }

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
        resyncProbeTask?.cancel()
        socket?.disconnect()
        socket = nil
    }

    /// Called when the app returns to the foreground. iOS suspends the socket
    /// while backgrounded and it often comes back half-open: sends "succeed"
    /// locally, nothing arrives, and the ping deadline takes tens of seconds
    /// to notice — the transcript sits stale until the person leaves and
    /// re-enters the session. Instead: re-send `watch` (the server replies
    /// with a full resync — transcript_init plus status/queue extras) and
    /// verify a frame actually comes back; if the socket is dead, tear it
    /// down and reconnect immediately.
    func appDidBecomeActive() {
        guard !stopped else { return }
        guard connectionState == .connected, let socket else {
            // Not connected (or a pre-suspension connect is stuck mid
            // handshake): skip the backoff and reconnect right now.
            reconnectTask?.cancel()
            self.socket?.disconnect()
            self.socket = nil
            connect()
            return
        }
        let probeStarted = Date()
        socket.watch(sessionId: session.id)
        resyncProbeTask?.cancel()
        resyncProbeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, !Task.isCancelled, !self.stopped else { return }
            if self.lastEventAt < probeStarted {
                // Half-open: the re-watch went into the void.
                self.socket?.disconnect()
                self.socket = nil
                self.connect()
            }
        }
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
        rebuildDisplayItems()
        socket.prompt(sessionId: session.id, content: text, user: ServerConfig.shared.userName)
    }

    func answer(question: AskQuestion, answers: [String: String]?) {
        socket?.answer(sessionId: session.id, questionId: question.id, answers: answers)
        pendingQuestion = nil
    }

    func cancelRun() {
        socket?.cancelWatchedRun()
    }

    func steerQueued(_ item: QueueItem) {
        socket?.steerQueued(sessionId: session.id, queueId: item.id)
    }

    func deleteQueued(_ item: QueueItem) {
        socket?.deleteQueued(sessionId: session.id, queueId: item.id)
        queuedItems.removeAll { $0.id == item.id }
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

    /// Internal (not private) so unit tests can drive the event state machine
    /// with raw frames without a live socket.
    func handle(_ event: ServerEvent) {
        lastEventAt = Date()
        switch event {
        case .hello:
            connectionState = .connected
            // Watch after the handshake frame so the send cannot race the upgrade.
            socket?.watch(sessionId: session.id)

        case .transcriptInit(let id, let newEntries) where id == session.id:
            entries = newEntries
            liveEntries.removeAll()
            localEchoIds.removeAll()
            rebuildDisplayItems()
            // A resync init (reconnect, foreground re-watch) can include
            // assistant blocks that are still sitting in the live bubble —
            // strip them or the same text renders twice.
            if !liveText.isEmpty || !pendingLiveText.isEmpty {
                flushLiveTextNow()
                for entry in newEntries.suffix(12)
                where entry.isAssistant && !entry.text.isEmpty {
                    liveText = liveText.replacingOccurrences(of: entry.text, with: "")
                }
                if liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    liveText = ""
                    if streamEnded { isStreaming = false }
                }
            }

        case .transcriptHistory(let id, let older) where id == session.id:
            let known = Set(entries.map(\.id))
            entries.insert(contentsOf: older.filter { !known.contains($0.id) }, at: 0)
            rebuildDisplayItems()

        case .transcriptAppend(let id, let appended) where id == session.id:
            upsert(appended)
            // Landed durably — drop the ephemeral copies (match by id, or by
            // toolUseId in case the two channels mint different entry ids).
            liveEntries.removeAll { live in
                appended.contains {
                    $0.id == live.id
                        || ($0.type == live.type && $0.toolUseId != nil
                            && $0.toolUseId == live.toolUseId)
                }
            }
            rebuildDisplayItems()
            // A mid-run assistant block that lands as a durable entry must be
            // stripped from the live bubble (it would render twice otherwise),
            // and remembered so a stream_text that arrives AFTER the append is
            // dropped instead of re-adding the block. Flush the coalescing
            // buffer first so a block split across flushed + pending text
            // still matches.
            flushLiveTextNow()
            for entry in appended where entry.isAssistant && !entry.text.isEmpty {
                liveText = liveText.replacingOccurrences(of: entry.text, with: "")
                landedStreamTexts.append(entry.text)
            }
            landedStreamTexts = Array(landedStreamTexts.suffix(30))
            if liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                liveText = ""
                if streamEnded { isStreaming = false }
            }

        case .streamStart(let id) where id == session.id:
            liveFlushTask?.cancel()
            liveFlushTask = nil
            pendingLiveText = ""
            liveText = ""
            liveEntries = []
            landedStreamTexts = []
            isStreaming = true
            streamEnded = false
            rebuildDisplayItems()

        case .streamText(let id, let text) where id == session.id:
            isStreaming = true
            if let landed = landedStreamTexts.firstIndex(of: text) {
                landedStreamTexts.remove(at: landed)
            } else {
                appendLiveText(text)
            }

        case .streamEntry(let id, let entry) where id == session.id:
            guard !entries.contains(where: { $0.id == entry.id }) else { break }
            if let index = liveEntries.firstIndex(where: { $0.id == entry.id }) {
                liveEntries[index] = entry
            } else {
                liveEntries.append(entry)
            }
            rebuildDisplayItems()

        case .streamDone(let id) where id == session.id:
            streamEnded = true
            flushLiveTextNow()

        case .sessionStatus(let id, let running) where id == session.id:
            isRunning = running
            if !running {
                streamEnded = true
                isStreaming = false
                flushLiveTextNow()
                // liveText is NOT cleared here: the durable entry usually lands
                // via transcript_append a beat later (1s file watcher) and the
                // strip there clears it — wiping now blinks the reply out.
            }

        case .queueUpdate(let id, let queued, let steered) where id == session.id:
            queuedItems = queued
            steeredItems = steered
            queuedCount = queued.count

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

    /// Transcript entries prepared for display: each tool_use is merged with
    /// its tool_result (matched on toolUseId, or the server's `tr-<id>`
    /// convention) into one collapsible item; orphan results stay standalone.
    enum DisplayItem: Identifiable, Equatable {
        case entry(TranscriptEntry)
        case toolCall(use: TranscriptEntry, result: TranscriptEntry?)

        var id: String {
            switch self {
            case .entry(let entry): entry.id
            case .toolCall(let use, _): "tool-\(use.id)"
            }
        }
    }

    /// Stored, not computed: rebuilt only when entries/liveEntries mutate.
    /// As a computed property it re-ran (dictionary builds and all) on every
    /// body evaluation — including each ~8Hz liveText flush mid-stream.
    private(set) var displayItems: [DisplayItem] = []

    private func rebuildDisplayItems() {
        // Durable file-ordered entries first, then the ephemeral live tail.
        var all = entries
        let knownIds = Set(entries.map(\.id))
        all.append(contentsOf: liveEntries.filter { !knownIds.contains($0.id) })

        var resultByUseId: [String: TranscriptEntry] = [:]
        for entry in all where entry.type == "tool_result" {
            let key = entry.toolUseId ?? String(entry.id.dropFirst("tr-".count))
            if resultByUseId[key] == nil { resultByUseId[key] = entry }
        }
        let useIds = Set(
            all.filter { $0.type == "tool_use" }.map { $0.toolUseId ?? $0.id }
        )
        var items: [DisplayItem] = []
        for entry in all {
            switch entry.type {
            case "tool_use":
                let key = entry.toolUseId ?? entry.id
                items.append(.toolCall(use: entry, result: resultByUseId[key]))
            case "tool_result":
                // Only orphans render standalone — a result whose use exists
                // anywhere in the transcript is folded into that item.
                let key = entry.toolUseId ?? String(entry.id.dropFirst("tr-".count))
                if !useIds.contains(key) {
                    items.append(.entry(entry))
                }
            default:
                items.append(.entry(entry))
            }
        }
        displayItems = items
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
