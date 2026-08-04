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

    private(set) var session: Session

    private(set) var entries: [TranscriptEntry] = []
    /// Ephemeral entries from the live engine stream (tool calls mid-run).
    /// They render at the end in stream order and graduate into `entries`
    /// when the file watcher lands them via transcript_append — the
    /// transcript FILE is the order authority. (Appending stream entries to
    /// `entries` directly put tool calls ahead of the assistant text that
    /// precedes them in the file, because that text lands ~1s later.)
    private(set) var liveEntries: [TranscriptEntry] = []
    private(set) var liveText = ""
    /// A run finishing settles the trailing turn — "Working" becomes
    /// "Worked", its duration resolves and its footer appears — so the block
    /// list has to be rebuilt on the flip, not just on entry mutations.
    private(set) var isStreaming = false {
        didSet { if oldValue != isStreaming { rebuildDisplayItems() } }
    }
    private(set) var isRunning: Bool {
        didSet { if oldValue != isRunning { rebuildDisplayItems() } }
    }
    /// Anchor for the elapsed-run clock. Opening a session mid-run uses the
    /// server's journaled run start (from the sessions list row); a run that
    /// starts while watching anchors to the status flip.
    private(set) var runStartedAt: Date?
    private(set) var queuedCount = 0
    /// Messages held for after the current run (editable, steerable).
    private(set) var queuedItems: [QueueItem] = []
    /// Steer receipts: delivering into the run at its next turn boundary.
    private(set) var steeredItems: [QueueItem] = []
    /// Chips the server's queue no longer lists but whose message hasn't
    /// landed in the transcript yet. The queue drain broadcasts the emptied
    /// queue BEFORE the delivered prompt reaches the transcript (the ~1s
    /// file watcher echoes it seconds later) — dropping the chip on that
    /// queue_update blinks the message out of the UI until the echo
    /// arrives. Held here (rendered as "Delivering…") until the durable
    /// user entry retires them; `pruneExpiredDelivering` drops ghosts whose
    /// echo never comes (e.g. deleted from another device).
    private(set) var deliveringItems: [QueueItem] = []
    private(set) var pendingQuestion: AskQuestion?
    private(set) var connectionState: ConnectionState = .connecting
    private(set) var isLoadingConversation = true
    private(set) var notice: String?
    var draft = ""
    /// Images staged in the composer, sent (as data URLs) with the next prompt.
    var attachedImages: [AttachedImage] = []
    /// Bumped on every send so the view can scroll to the bottom: the
    /// scroll view's bottom size-change anchor doesn't re-pin once the
    /// reader has scrolled (or the keyboard resized the viewport), leaving
    /// a just-sent message below the fold.
    private(set) var sendSeq = 0

    // ── Pull request ──
    /// PR details for the session's branch (toolbar chip + PR panel).
    /// nil until the first fetch lands — the chip falls back to the sessions
    /// list's prNumber snapshot meanwhile — and stays nil when there's no PR.
    private(set) var prDetails: PrDetails?
    /// A fetch failed with nothing loaded — the panel offers a retry instead
    /// of an endless spinner.
    private(set) var prLoadFailed = false
    private var prTask: Task<Void, Never>?

    // ── Team notes ──

    /// Human-to-human notes on this session, interleaved into the transcript
    /// by the time they were written. The agent never sees them.
    private(set) var notes: [SessionNote] = []
    private var notesTask: Task<Void, Never>?

    // ── Per-session run settings ──
    /// Current model id ("" = server default). Changing routes through the
    /// `/model` slash command, which persists + notices like the web picker.
    private(set) var model: String
    /// Reasoning effort; rides every send and persists server-side. "" = unset.
    var effort: String
    /// OpenAI fast-mode flag; rides every send like effort.
    var fastMode: Bool

    // ── Earlier-history paging ──
    /// Older history exists server-side (transcript_init/history `truncated`).
    private(set) var canLoadEarlier = false
    private(set) var loadingEarlier = false
    /// Bumped on every history prepend so the view can restore the reader's
    /// scroll position after a requested page arrives.
    private(set) var historyPrependSeq = 0
    private var historyStartOffset: Int?
    private var historyRev: String?
    private var historyFirstSeq: Int?

    private var socket: (any SessionSocket)?
    /// Injection seam for tests; production always builds a real OS1Socket.
    private let socketFactory: @MainActor () -> any SessionSocket
    private var reconnectTask: Task<Void, Never>?
    /// Multiple views can briefly overlap during a reversed tab transition.
    /// The connection stays alive until the last mounted view releases it.
    private var viewOwners: Set<UUID> = []
    /// Foreground liveness probe (see `appDidBecomeActive`).
    private var resyncProbeTask: Task<Void, Never>?
    /// When the last server frame arrived — any frame counts.
    private var lastEventAt = Date.distantPast
    private var stopped = true
    /// stream_done arrived; the durable entry lands via the next transcript_append.
    private var streamEnded = true
    /// Optimistic local user messages, removed once the server echoes them back.
    private var localEchoIds: Set<String> = []
    /// Chip ids whose message text landed in a user entry that arrived AFTER
    /// the chip was known — marked by `upsert` echoes and by resync entries
    /// under previously-unknown ids. `messageLanded` reads this instead of
    /// scanning the transcript, which false-positived on repeated sends.
    private var landedChipIds: Set<String> = []
    /// When each delivering chip entered the holding state (for the prune).
    private var deliveringSince: [String: Date] = [:]
    private var deliveringPruneTask: Task<Void, Never>?
    /// How long a delivering chip may wait for its transcript echo before
    /// being dropped as a ghost. Internal so tests can reference it.
    let deliveringGrace: TimeInterval = 30
    /// Assistant blocks that already landed as transcript entries. Opencode
    /// streams whole completed blocks, and the durable entry can beat the
    /// stream_text broadcast (or vice versa) — without this the same text
    /// shows twice: in the transcript AND in the live bubble. Mirrors the
    /// web viewer's landedStreamTextRef.
    private var landedStreamTexts: [String] = []
    /// Assistant entries newly discovered by the last resync. Restricting
    /// partial-response reconciliation to these avoids matching an unrelated
    /// historical response that happens to start with the same words.
    private var resyncAssistantCandidates: [TranscriptEntry] = []
    /// Stream text is coalesced here and flushed to `liveText` at ~8Hz:
    /// every liveText change re-parses the whole bubble's markdown and
    /// re-anchors the scroll view, so per-chunk updates burn a full layout
    /// pass each on fast streams.
    private var pendingLiveText = ""
    private var liveFlushTask: Task<Void, Never>?
    /// Ids for graduated live-text entries (see `graduateLiveText`).
    private var liveTextSeq = 0

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

    /// Move the accumulated live text into an ordered ephemeral entry the
    /// moment a tool call arrives. The text chronologically PRECEDES the tool
    /// call, but the live bubble renders after everything — leaving it there
    /// shows the turn in the wrong order until the durable entry lands, and
    /// the ~1s-later reshuffle reads as flicker. Graduated entries are
    /// stripped the same way the live bubble is once the durable copy lands.
    private func graduateLiveText() {
        flushLiveTextNow()
        guard !liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        liveTextSeq += 1
        liveEntries.append(TranscriptEntry(
            id: "live-text-\(liveTextSeq)",
            type: "assistant",
            content: liveText
        ))
        liveText = ""
    }

    /// Strip one landed assistant block from the live bubble and from any
    /// graduated live-text entries; drops graduated entries that end up empty.
    /// Returns whether the text was found anywhere.
    private func stripLanded(_ text: String) -> Bool {
        var found = false
        if liveText.contains(text) {
            liveText = liveText.replacingOccurrences(of: text, with: "")
            found = true
        }
        for index in liveEntries.indices
        where liveEntries[index].id.hasPrefix("live-text-") {
            if let content = liveEntries[index].content, content.contains(text) {
                liveEntries[index].content = content.replacingOccurrences(of: text, with: "")
                found = true
            }
        }
        liveEntries.removeAll {
            $0.id.hasPrefix("live-text-")
                && $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return found
    }

    /// Reconcile a cached partial response after reconnecting. Only a finished
    /// stream is eligible: while a run is active, an older assistant message
    /// may legitimately begin with the same words as the current response.
    private func reconcileFinishedLiveText() {
        guard streamEnded || !isRunning else { return }
        defer { resyncAssistantCandidates = [] }
        guard !liveText.isEmpty || !pendingLiveText.isEmpty else { return }

        flushLiveTextNow()
        for entry in resyncAssistantCandidates where !entry.text.isEmpty {
            liveText = liveText.replacingOccurrences(of: entry.text, with: "")
        }
        let residual = liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !residual.isEmpty,
           resyncAssistantCandidates.contains(where: {
               $0.text.trimmingCharacters(in: .whitespacesAndNewlines)
                       .hasPrefix(residual)
           }) {
            // The app disconnected mid-block; the snapshot now carries the
            // completed response whose prefix is the cached streaming text.
            liveText = ""
        }
        if liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            liveText = ""
            isStreaming = false
        }
    }

    /// Seed for a just-created session: the opening prompt (and images) render
    /// immediately while the server is still persisting the session file.
    struct OptimisticSeed {
        let prompt: String
        let images: [String]
    }

    /// Composer state parked by the list while switching workspace tabs.
    /// Keeping it outside the discarded conversation view preserves unsent
    /// text and staged screenshots without observing draft changes in the
    /// transcript view's body on every keystroke.
    struct ComposerDraft {
        let text: String
        let images: [AttachedImage]

        var isEmpty: Bool { text.isEmpty && images.isEmpty }
    }

    /// True until the first transcript_init lands for a session opened right
    /// after creation — "Session not found" watch errors are retried quietly
    /// instead of surfaced (the server persists the file a few seconds after
    /// returning the id).
    private var awaitingCreation = false
    private var creationRetryTask: Task<Void, Never>?
    private var creationRetriesLeft = 40

    init(
        session: Session,
        seed: OptimisticSeed? = nil,
        composerDraft: ComposerDraft? = nil,
        socketFactory: @escaping @MainActor () -> any SessionSocket = { OS1Socket() }
    ) {
        self.session = session
        self.socketFactory = socketFactory
        self.isRunning = session.isRunning ?? false
        self.queuedCount = session.queuedCount ?? 0
        self.model = session.model ?? ""
        self.effort = session.effort ?? ""
        self.fastMode = session.fastMode ?? false
        if let composerDraft {
            self.draft = composerDraft.text
            self.attachedImages = composerDraft.images
        }
        if self.isRunning {
            self.runStartedAt = session.runStartedDate
        }
        if let seed {
            awaitingCreation = true
            isLoadingConversation = false
            // Echo semantics: the server's own copy of the opening prompt
            // replaces this seed when it lands via transcript_append.
            localEchoIds.insert("optimistic-prompt")
            entries = [TranscriptEntry(
                id: "optimistic-prompt",
                type: "user",
                content: seed.prompt,
                timestamp: ISO8601DateFormatter().string(from: .now),
                images: seed.images.isEmpty ? nil : seed.images
            )]
            rebuildDisplayItems()
        }
    }

    /// A cached conversation may be reopened from an older list-row snapshot.
    /// Keep its loaded transcript while refreshing title/worktree/PR metadata.
    func updateSessionSnapshot(_ session: Session) {
        guard session.id == self.session.id else { return }
        let hadWalkthrough = self.session.walkthrough
        self.session = session
        // The walkthrough rides on the session row, not the transcript, so a
        // newly published one only reaches the blocks through a rebuild.
        if session.walkthrough != hadWalkthrough { rebuildDisplayItems() }
        guard stopped else { return }

        if let running = session.isRunning {
            isRunning = running
            runStartedAt = running ? session.runStartedDate : nil
            if !running {
                streamEnded = true
                isStreaming = false
            }
        }
        queuedCount = session.queuedCount ?? 0
        model = session.model ?? ""
        effort = session.effort ?? ""
        fastMode = session.fastMode ?? false
    }

    func start() {
        viewOwners.removeAll()
        startConnection()
    }

    func start(owner: UUID) {
        let wasInactive = viewOwners.isEmpty
        viewOwners.insert(owner)
        if wasInactive { startConnection() }
    }

    private func startConnection() {
        stopped = false
        connect()
        loadPr()
        loadNotes()
    }

    func stop() {
        viewOwners.removeAll()
        stopConnection()
    }

    func stop(owner: UUID) {
        guard viewOwners.remove(owner) != nil else { return }
        if viewOwners.isEmpty { stopConnection() }
    }

    private func stopConnection() {
        stopped = true
        reconnectTask?.cancel()
        resyncProbeTask?.cancel()
        creationRetryTask?.cancel()
        deliveringPruneTask?.cancel()
        prTask?.cancel()
        notesTask?.cancel()
        socket?.disconnect()
        socket = nil
    }

    /// Backfill the session's notes. Live ones arrive over the WS, so this
    /// runs once per connect; a failure just leaves the transcript noteless.
    private func loadNotes() {
        notesTask?.cancel()
        notesTask = Task { [weak self] in
            guard let sessionId = self?.session.id,
                  let loaded = try? await OS1API.sessionNotes(sessionId: sessionId),
                  let self, !Task.isCancelled
            else { return }
            // Anything that arrived over the WS while this was in flight wins.
            let known = Set(self.notes.map(\.id))
            let merged = loaded.filter { !known.contains($0.id) } + self.notes
            guard merged != self.notes else { return }
            self.notes = merged.sorted { $0.ts < $1.ts }
            self.rebuildDisplayItems()
        }
    }

    /// Fire-and-forget PR refresh (open, foreground, run end).
    func loadPr() {
        prTask?.cancel()
        prTask = Task { [weak self] in
            await self?.refreshPr()
        }
    }

    /// Awaitable PR refresh for the panel's pull-to-refresh / retry. A failure
    /// keeps whatever we already have — stale beats blank; only a failure with
    /// nothing loaded surfaces as prLoadFailed.
    func refreshPr() async {
        do {
            let details = try await OS1API.pr(sessionId: session.id)
            guard !Task.isCancelled else { return }
            prDetails = details
            prLoadFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            prLoadFailed = prDetails == nil
        }
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
        loadPr()
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
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachedImages.isEmpty)
            && connectionState == .connected
    }

    func sendDraft(busyModeOverride: String? = nil) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachedImages.map(\.dataURL)
        guard !text.isEmpty || !images.isEmpty, let socket else { return }
        // You can't be done with a chat you're actively working in: prompting
        // clears any sidebar hide covering it (opening it deliberately doesn't).
        HideStore.shared.unhide(for: session)
        draft = ""
        attachedImages = []
        let busyMode = busyModeOverride
            ?? UserDefaults.standard.string(forKey: "os1.composer.busySend")
            ?? "queue"
        if isRunning {
            // A send during a run is held server-side (busyMode "queue") and
            // only enters the transcript when the queue delivers it after the
            // run — echoing it into the thread now would strand a bubble out
            // of chronological order. Echo it as a queue chip instead; the
            // server's next queue_update replaces this local copy.
            let item = QueueItem(
                id: "local-queued-\(UUID().uuidString)",
                content: text,
                user: ServerConfig.shared.userName
            )
            if busyMode == "steer" { steeredItems.append(item) }
            else { queuedItems.append(item) }
            queuedCount = queuedItems.count
        } else {
            let localId = "local-\(UUID().uuidString)"
            localEchoIds.insert(localId)
            entries.append(TranscriptEntry(
                id: localId,
                type: "user",
                content: text,
                timestamp: ISO8601DateFormatter().string(from: .now),
                images: images.isEmpty ? nil : images
            ))
            rebuildDisplayItems()
        }
        socket.prompt(
            sessionId: session.id,
            content: text,
            user: ServerConfig.shared.userName,
            images: images.isEmpty ? nil : images,
            effort: effort.isEmpty ? nil : effort,
            fastMode: fastMode ? true : nil,
            busyMode: busyMode
        )
        sendSeq += 1
    }

    /// Switch this session's model via the `/model` slash command — handled
    /// server-side (persists, notices, broadcasts) without reaching the engine.
    func changeModel(to id: String) {
        guard !id.isEmpty, id != model, let socket else { return }
        model = id
        // A model family switch invalidates the old effort/fast picks; reset
        // to server defaults rather than carrying them across.
        effort = ""
        fastMode = false
        socket.prompt(
            sessionId: session.id,
            content: "/model \(id)",
            user: ServerConfig.shared.userName
        )
    }

    func answer(question: AskQuestion, answers: [String: String]?) {
        socket?.answer(sessionId: session.id, questionId: question.id, answers: answers)
        pendingQuestion = nil
    }

    func cancelRun() {
        socket?.cancelWatchedRun()
    }

    /// Ask the server for one page of history older than what we hold.
    func loadEarlier() {
        guard canLoadEarlier, !loadingEarlier, connectionState == .connected,
              let socket else { return }
        if let seq = historyFirstSeq, seq > 1 {
            loadingEarlier = true
            socket.loadHistory(sessionId: session.id, beforeSeq: seq)
        } else if let offset = historyStartOffset, offset > 0 {
            loadingEarlier = true
            socket.loadHistory(
                sessionId: session.id, beforeOffset: offset, beforeRev: historyRev
            )
        } else {
            canLoadEarlier = false
        }
    }

    private func applyHistoryCursor(_ cursor: HistoryCursor) {
        canLoadEarlier = cursor.truncated
        historyStartOffset = cursor.startOffset
        if let rev = cursor.rev { historyRev = rev }
        historyFirstSeq = cursor.firstSeq
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
        connectionState =
            (entries.isEmpty || awaitingCreation) ? .connecting : .reconnecting(nil)
        let socket = socketFactory()
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

        case .transcriptInit(let id, let newEntries, let cursor) where id == session.id:
            creationRetryTask?.cancel()
            // A fresh session's first init can arrive before the engine wrote
            // anything — keep the optimistic prompt bubble rather than blanking
            // the conversation; the real entries land via transcript_append.
            if awaitingCreation && newEntries.isEmpty && !entries.isEmpty {
                awaitingCreation = false
                isLoadingConversation = false
                applyHistoryCursor(cursor)
                loadingEarlier = false
                break
            }
            awaitingCreation = false
            // Entries the snapshot adds under ids we didn't hold arrived
            // while we were out of sync — they are the only echo candidates
            // for chips and optimistic bubbles. Matching the WHOLE snapshot
            // used to false-positive on repeated sends ("continue"): an old
            // identical message retired the fresh chip and blinked the
            // message out until its real echo landed.
            let knownIds = Set(entries.map(\.id))
            resyncAssistantCandidates = if isRunning && knownIds.isEmpty {
                // First-load snapshots are all "new" locally; none can be
                // attributed to the current stream safely.
                []
            } else {
                newEntries.filter {
                    $0.isAssistant && !knownIds.contains($0.id)
                }
            }
            for candidate in newEntries
            where candidate.isUser && !knownIds.contains(candidate.id) {
                for chip in queuedItems + steeredItems + deliveringItems
                where chipDelivered(chip, in: candidate.text) {
                    landedChipIds.insert(chip.id)
                }
            }
            // Optimistic bubbles whose echo the snapshot doesn't carry
            // survive the resync: an init can race the ~1s persist of a
            // delivered send — or the send was QUEUED server-side behind a
            // run this client thought idle — and wiping the bubble blinks
            // the message out until it finally lands.
            let pendingEchoes = entries.filter { echo in
                localEchoIds.contains(echo.id) && !newEntries.contains {
                    !knownIds.contains($0.id) && echoDelivered(echo, in: $0)
                }
            }
            entries = newEntries + pendingEchoes
            isLoadingConversation = false
            liveEntries.removeAll()
            localEchoIds = Set(pendingEchoes.map(\.id))
            // A resync snapshot is authoritative for landed messages — no
            // upsert runs on it, so retire delivered chips here.
            if !deliveringItems.isEmpty {
                updateDelivering(deliveringItems.filter { !messageLanded($0) })
            }
            applyHistoryCursor(cursor)
            // A rev-mismatch reply to load_history comes back as a fresh init.
            loadingEarlier = false
            rebuildDisplayItems()
            // A reconnect can include the durable form of a cached live
            // response. Reconcile only once that stream is known finished.
            reconcileFinishedLiveText()

        case .transcriptHistory(let id, let older, let cursor) where id == session.id:
            let known = Set(entries.map(\.id))
            entries.insert(contentsOf: older.filter { !known.contains($0.id) }, at: 0)
            applyHistoryCursor(cursor)
            loadingEarlier = false
            historyPrependSeq += 1
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
            // A mid-run assistant block that lands as a durable entry must be
            // stripped from the live bubble and graduated entries (it would
            // render twice otherwise). Blocks the strip does NOT find are
            // remembered so a stream_text that arrives AFTER the append is
            // dropped instead of re-adding the block. Flush the coalescing
            // buffer first so a block split across flushed + pending text
            // still matches.
            flushLiveTextNow()
            for entry in appended where entry.isAssistant && !entry.text.isEmpty {
                if !stripLanded(entry.text) {
                    landedStreamTexts.append(entry.text)
                }
            }
            landedStreamTexts = Array(landedStreamTexts.suffix(30))
            if liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                liveText = ""
                if streamEnded { isStreaming = false }
            }
            rebuildDisplayItems()

        case .streamStart(let id) where id == session.id:
            liveFlushTask?.cancel()
            liveFlushTask = nil
            pendingLiveText = ""
            liveText = ""
            liveEntries = []
            landedStreamTexts = []
            resyncAssistantCandidates = []
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
            graduateLiveText()
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
            let completed = isRunning && !running
            if running {
                // Keep the earliest known anchor across resync re-sends.
                if runStartedAt == nil {
                    runStartedAt = session.runStartedDate ?? Date()
                }
            } else {
                runStartedAt = nil
            }
            isRunning = running
            if completed {
                NativeNotifications.post(
                    event: "runComplete",
                    title: session.displayTitle,
                    body: "The session finished running."
                )
            }
            if !running {
                streamEnded = true
                isStreaming = false
                flushLiveTextNow()
                reconcileFinishedLiveText()
                // Unmatched liveText is not cleared here: the durable entry
                // usually lands via transcript_append a beat later (1s file
                // watcher) and the strip there clears it. Wiping now blinks.
                // A finished run often just opened or pushed to a PR — refresh
                // the chip/panel (served from the server's PR cache, so cheap).
                loadPr()
            }

        case .queueUpdate(let id, let queued, let steered) where id == session.id:
            // A chip that vanishes from the server's queue without its message
            // having landed in the transcript is mid-delivery: the drain
            // broadcasts the emptied queue before the engine turn writes the
            // user entry (which reaches us via the ~1s file watcher). Hold it
            // as "delivering" instead of blinking the message out of the UI.
            // A chip the frame still lists — by id, or by content for a local
            // chip being replaced with the server's copy — is simply replaced.
            let incoming = queued + steered
            // A send echoed as a thread bubble (the session looked idle) that
            // the server actually QUEUED behind a run: the chip is now the
            // message's representation — it enters the transcript only at the
            // drain — so drop the bubble rather than showing an out-of-order
            // thread copy the next resync would wipe.
            if !localEchoIds.isEmpty {
                let queuedContents = Set(incoming.map {
                    $0.content.trimmingCharacters(in: .whitespacesAndNewlines)
                })
                let orphaned = Set(entries.filter { echo in
                    localEchoIds.contains(echo.id) && queuedContents.contains(
                        echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    )
                }.map(\.id))
                if !orphaned.isEmpty {
                    localEchoIds.subtract(orphaned)
                    entries.removeAll { orphaned.contains($0.id) }
                    rebuildDisplayItems()
                }
            }
            var held = Set<String>()
            updateDelivering(
                (queuedItems + steeredItems + deliveringItems).filter { chip in
                    guard held.insert(chip.id).inserted else { return false }
                    let replaced = incoming.contains {
                        $0.id == chip.id || $0.content == chip.content
                    }
                    return !replaced && !messageLanded(chip)
                }
            )
            queuedItems = queued
            steeredItems = steered
            queuedCount = queued.count
            // Landed flags outlive their purpose once the chip is gone.
            landedChipIds.formIntersection(
                Set((queued + steered + deliveringItems).map(\.id))
            )

        case .askQuestion(let id, let question) where id == session.id:
            let isNewQuestion = pendingQuestion?.id != question.id
            pendingQuestion = question
            if isNewQuestion {
                NativeNotifications.post(
                    event: "needsInput",
                    title: session.displayTitle,
                    body: "The session needs your input."
                )
            }

        case .askResolved(let id, let questionId) where id == session.id:
            if pendingQuestion?.id == questionId { pendingQuestion = nil }

        case .serverError(let message)
        where awaitingCreation && message == "Session not found":
            // Freshly created session the server hasn't persisted yet — re-send
            // the watch until it exists (usually a few seconds, up to ~15s on a
            // slow engine boot) instead of surfacing an error.
            creationRetriesLeft -= 1
            guard creationRetriesLeft > 0 else {
                awaitingCreation = false
                notice = "Session is taking unusually long to appear — pull the list to refresh."
                break
            }
            creationRetryTask?.cancel()
            creationRetryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.5))
                guard let self, !Task.isCancelled, !self.stopped else { return }
                self.socket?.watch(sessionId: self.session.id)
            }

        case .chatNote(let channel, let note)
            where channel == SessionNote.channel(for: session.id):
            // Chat frames go to every client, so an edit of an existing note
            // replaces it in place rather than appending a duplicate.
            if let index = notes.firstIndex(where: { $0.id == note.id }) {
                guard notes[index] != note else { return }
                notes[index] = note
            } else {
                notes.append(note)
                notes.sort { $0.ts < $1.ts }
            }
            rebuildDisplayItems()

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
        /// `isLive` distinguishes the current stream from incomplete historical
        /// entries, which may not have a matching result after a reload.
        case toolCall(use: TranscriptEntry, result: TranscriptEntry?, isLive: Bool)

        var id: String {
            switch self {
            case .entry(let entry): entry.id
            case .toolCall(let use, _, _): "tool-\(use.id)"
            }
        }
    }

    /// Stored, not computed: rebuilt only when entries/liveEntries mutate.
    /// As a computed property it re-ran (dictionary builds and all) on every
    /// body evaluation — including each ~8Hz liveText flush mid-stream.
    private(set) var displayItems: [DisplayItem] = []

    /// What the transcript actually renders: `displayItems` folded into turns
    /// (see `TranscriptGrouping`). `displayItems` stays flat because the
    /// scroll pin follows its count — grouping alone would hold that count
    /// steady while a live turn grows, and new output would stop following.
    private(set) var displayBlocks: [TranscriptBlock] = []

    /// Fold state, kept off the observation graph — see `FoldStateStore`.
    /// It outlives the view tree because `@State` inside a `LazyVStack` row is
    /// destroyed the moment the row leaves the realization window.
    @ObservationIgnored private let folds = FoldStateStore()

    func foldState(for turn: WorkTurn, preference: String) -> TurnFoldState {
        folds.fold(for: turn, preference: preference)
    }

    func expansionState(id: String, defaultExpanded: Bool = false) -> TurnFoldState {
        folds.expansion(id: id, defaultExpanded: defaultExpanded)
    }

    /// Which block currently renders `entryId` — how a scroll anchor captured
    /// before a history prepend survives the regroup that follows it (the
    /// entry may have been swallowed into a turn with a different id).
    func blockId(containing entryId: String) -> String? {
        displayBlocks.first { $0.entryIds.contains(entryId) }?.id
    }

    /// The transcript entry a scroll restore should re-find after a prepend.
    var topmostEntryId: String? {
        displayBlocks.first?.entryIds.first
    }

    private func rebuildDisplayItems() {
        // Durable file-ordered entries first, then the ephemeral live tail.
        var all = entries
        let knownIds = Set(entries.map(\.id))
        all.append(contentsOf: liveEntries.filter { !knownIds.contains($0.id) })

        let items = TranscriptGrouping.displayItems(
            from: all,
            liveIds: Set(liveEntries.map(\.id))
        )
        displayItems = items
        displayBlocks = TranscriptGrouping.blocks(
            from: items,
            live: isRunning || isStreaming,
            worktreeDir: session.worktreeDir,
            notes: notes,
            walkthrough: session.walkthrough
        )
    }

    private func upsert(_ incoming: [TranscriptEntry]) {
        for entry in incoming {
            if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                entries[index] = entry
            } else {
                // Drop the optimistic copy once the server's own user entry
                // arrives — verbatim, or the attributed/batched drain form
                // for a send that spent time in the queue.
                if entry.isUser, let localIndex = entries.firstIndex(where: {
                    localEchoIds.contains($0.id) && echoDelivered($0, in: entry)
                }) {
                    localEchoIds.remove(entries[localIndex].id)
                    entries.remove(at: localIndex)
                }
                // A send made while the run looked busy but was actually
                // delivered straight to the engine (run ended in the gap)
                // never gets a queue_update — retire its local chip when the
                // server's user entry lands instead.
                if entry.isUser, let chipIndex = queuedItems.firstIndex(where: {
                    $0.id.hasPrefix("local-queued-") && chipDelivered($0, in: entry.text)
                }) {
                    queuedItems.remove(at: chipIndex)
                    queuedCount = queuedItems.count
                }
                // The durable copy of a delivering chip's message landing is
                // the hand-off the holding state exists for — one entry can
                // retire several chips (multi-message drains join a batch
                // into a single attributed user entry).
                if entry.isUser,
                   deliveringItems.contains(where: { chipDelivered($0, in: entry.text) }) {
                    updateDelivering(
                        deliveringItems.filter { !chipDelivered($0, in: entry.text) }
                    )
                }
                // Chips the server still lists as queued/steered when their
                // echo lands are remembered — the eventual drain drops them
                // outright instead of holding a delivered message as a
                // "Delivering…" ghost.
                if entry.isUser {
                    for chip in queuedItems + steeredItems
                    where chipDelivered(chip, in: entry.text) {
                        landedChipIds.insert(chip.id)
                    }
                }
                entries.append(entry)
            }
        }
    }

    // MARK: - Delivering chips

    /// Whether a landed user entry's text is the delivered form of `chip`:
    /// bare, attributed ("[user] content" — the steer and batched-drain
    /// form), or embedded in a joined batch / fenced-context wrapper.
    /// Containment mirrors the server's own steer-receipt reconciliation.
    private func chipDelivered(_ chip: QueueItem, in text: String) -> Bool {
        let content = chip.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return true }
        return text.contains(content)
    }

    /// Whether `chip`'s message has landed SINCE the chip existed. Reads the
    /// flags marked by `upsert` and the resync path — a whole-transcript text
    /// scan here retired fresh chips against old identical messages and
    /// blinked repeated sends out of the UI until their real echo arrived.
    private func messageLanded(_ chip: QueueItem) -> Bool {
        landedChipIds.contains(chip.id)
    }

    /// Whether a server user entry is the delivered form of an optimistic
    /// echo bubble: verbatim, or embedded in the attributed/batched drain
    /// form ("[user] content").
    private func echoDelivered(_ echo: TranscriptEntry, in entry: TranscriptEntry) -> Bool {
        guard entry.isUser else { return false }
        let content = echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return true }
        return entry.content == echo.content || entry.text.contains(content)
    }

    private func updateDelivering(_ items: [QueueItem]) {
        deliveringItems = items
        let now = Date()
        var since: [String: Date] = [:]
        for item in items { since[item.id] = deliveringSince[item.id] ?? now }
        deliveringSince = since
        deliveringPruneTask?.cancel()
        deliveringPruneTask = nil
        guard !items.isEmpty else { return }
        deliveringPruneTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                self.pruneExpiredDelivering()
                if self.deliveringItems.isEmpty { return }
            }
        }
    }

    /// Drop delivering chips whose transcript echo never came (deleted from
    /// another device, server restart) once the grace window passes.
    /// Internal so tests can drive it with a fixed clock.
    func pruneExpiredDelivering(now: Date = Date()) {
        let live = deliveringItems.filter { chip in
            guard let start = deliveringSince[chip.id] else { return true }
            return now.timeIntervalSince(start) < deliveringGrace
        }
        guard live.count != deliveringItems.count else { return }
        updateDelivering(live)
    }
}
