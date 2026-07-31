import XCTest
@testable import OS1

/// State-machine tests for `SessionViewModel.handle`: the dedupe dance between
/// the ephemeral stream channel (stream_text / stream_tool_*) and the durable
/// transcript channel (transcript_append / resync transcript_init) is where
/// every "text renders twice" bug has lived — each case here pins one of them.
@MainActor
final class SessionViewModelTests: XCTestCase {
    private let serverA = SessionViewModelCache.Scope(serverURL: "server-a", token: "token-a")
    private let serverB = SessionViewModelCache.Scope(serverURL: "server-b", token: "token-b")

    private func makeViewModel() -> SessionViewModel {
        SessionViewModel(session: Session(id: "bks-1"))
    }

    private func entry(
        _ id: String, _ type: String, text: String? = nil, toolUseId: String? = nil
    ) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text, toolUseId: toolUseId)
    }

    func testPageCacheReusesLoadedConversationAndRefreshesSessionSnapshot() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(for: Session(id: "bks-1", title: "Old"), scope: serverA)
        first.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "assistant", text: "Already loaded")],
            cursor: .empty
        ))

        let reopened = cache.viewModel(
            for: Session(id: "bks-1", title: "Updated"),
            scope: serverA
        )

        XCTAssertTrue(first === reopened)
        XCTAssertFalse(reopened.isLoadingConversation)
        XCTAssertEqual(reopened.entries.map(\.id), ["e1"])
        XCTAssertEqual(reopened.session.title, "Updated")
    }

    func testPageCacheEvictsLeastRecentlyUsedConversation() {
        let cache = SessionViewModelCache(capacity: 2)
        _ = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-2"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-3"), scope: serverA)

        XCTAssertEqual(cache.cachedSessionIds, ["bks-1", "bks-3"])
    }

    func testPageCacheDoesNotCrossServerScope() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        let otherServer = cache.viewModel(for: Session(id: "bks-1"), scope: serverB)

        XCTAssertFalse(first === otherServer)
        XCTAssertEqual(cache.cachedSessionIds, ["bks-1"])
    }

    func testCachedConversationReconcilesOperationalStateWhileStopped() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(
            for: Session(
                id: "bks-1", model: "old", effort: "low",
                fastMode: false, isRunning: true, queuedCount: 2
            ),
            scope: serverA
        )
        first.stop()

        let reopened = cache.viewModel(
            for: Session(
                id: "bks-1", model: "new", effort: "high",
                fastMode: true, isRunning: false, queuedCount: 0
            ),
            scope: serverA
        )

        XCTAssertFalse(reopened.isRunning)
        XCTAssertEqual(reopened.queuedCount, 0)
        XCTAssertEqual(reopened.model, "new")
        XCTAssertEqual(reopened.effort, "high")
        XCTAssertTrue(reopened.fastMode)
    }

    func testResyncDropsCachedPartialPrefixOfOffscreenCompletion() {
        let viewModel = makeViewModel()
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Partial repl"))
        viewModel.stop()
        viewModel.updateSessionSnapshot(Session(id: "bks-1", isRunning: false))

        var snapshot = [entry(
            "e1", "assistant", text: "Partial reply completed off-screen"
        )]
        snapshot += (2...20).map {
            entry("e\($0)", $0.isMultiple(of: 2) ? "user" : "assistant", text: "Later \($0)")
        }

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: snapshot,
            cursor: .empty
        ))

        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.count, 20)
    }

    func testActiveResyncKeepsLiveTextMatchingHistoricalPrefix() {
        let viewModel = makeViewModel()
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "I can help"))

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("old", "assistant", text: "I can help with the old task")],
            cursor: .empty
        ))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))

        XCTAssertEqual(viewModel.liveText, "I can help")
    }

    func testOverlappingViewOwnersKeepSocketAliveUntilLastRelease() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket }
        )
        let outgoing = UUID()
        let incoming = UUID()

        viewModel.start(owner: outgoing)
        viewModel.start(owner: incoming)
        viewModel.stop(owner: outgoing)

        XCTAssertEqual(socket.connectCount, 1)
        XCTAssertEqual(socket.disconnectCount, 0)

        viewModel.stop(owner: incoming)
        XCTAssertEqual(socket.disconnectCount, 1)
    }

    func testTranscriptInitPopulatesEntries() {
        let viewModel = makeViewModel()
        XCTAssertTrue(viewModel.isLoadingConversation)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "hi"),
            entry("e2", "assistant", text: "hello"),
        ], cursor: .empty))
        XCTAssertFalse(viewModel.isLoadingConversation)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
        XCTAssertEqual(viewModel.displayItems.map(\.id), ["e1", "e2"])
    }

    func testEventsForOtherSessionsAreIgnored() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-other", entries: [entry("x", "user")], cursor: .empty))
        viewModel.handle(.streamStart(sessionId: "bks-other"))
        viewModel.handle(.streamText(sessionId: "bks-other", text: "nope"))
        XCTAssertTrue(viewModel.isLoadingConversation)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
    }

    func testStreamTextAccumulatesAndFlushesOnDone() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        XCTAssertTrue(viewModel.isStreaming)
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello "))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "world"))
        // Chunks coalesce off-screen until a flush point (stream_done here).
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "Hello world")
    }

    func testAppendStripsLandedTextFromLiveBubble() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world")
        ]))
        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1"])
    }

    func testStreamTextArrivingAfterItsAppendIsDropped() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        // Durable entry beats the stream broadcast (1s file watcher won the race).
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "block A")
        ]))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "block A"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "", "already-landed block must not re-enter the live bubble")
        XCTAssertEqual(viewModel.entries.count, 1)
    }

    /// The foreground-resync fix: a re-watch's transcript_init carries blocks
    /// that are still sitting in the live bubble — they must be stripped.
    func testResyncInitStripsAlreadyLandedLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        // Foreground re-watch → full resync containing the same block.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi"),
            entry("e1", "assistant", text: "Hello world"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.liveText, "", "resynced block would render twice")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1", "e1"])
    }

    func testResyncInitKeepsUnlandedTail() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world. And more"))
        // Resync landed only the first block; the tail is still live-only.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world.")
        ], cursor: .empty))
        XCTAssertTrue(viewModel.liveText.contains("And more"))
        XCTAssertFalse(viewModel.liveText.contains("Hello world."))
    }

    func testHistoryPrependsWithoutDuplicates() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [entry("e2", "user", text: "recent")], cursor: .empty))
        viewModel.handle(.transcriptHistory(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "older"),
            entry("e2", "user", text: "recent"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
    }

    func testAppendUpsertsById() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [entry("e1", "assistant", text: "draft")]))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [entry("e1", "assistant", text: "final")]))
        XCTAssertEqual(viewModel.entries.count, 1)
        XCTAssertEqual(viewModel.entries[0].text, "final")
    }

    func testToolUseAndResultMergeIntoOneDisplayItem() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "tool_use", toolUseId: "tu-1"),
            entry("tr-tu-1", "tool_result", text: "ok", toolUseId: "tu-1"),
            entry("tr-orphan", "tool_result", text: "lost"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.displayItems.count, 2)
        guard case .toolCall(let use, let result, let isLive) = viewModel.displayItems[0] else {
            return XCTFail("expected merged tool call")
        }
        XCTAssertEqual(use.id, "e1")
        XCTAssertEqual(result?.text, "ok")
        XCTAssertFalse(isLive)
        guard case .entry(let orphan) = viewModel.displayItems[1] else {
            return XCTFail("orphan tool_result should render standalone")
        }
        XCTAssertEqual(orphan.id, "tr-orphan")
    }

    func testOnlyCurrentStreamToolCallIsLive() {
        let viewModel = makeViewModel()
        // An incomplete historical entry must not reopen just because it has no result.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("old-tool", "tool_use", toolUseId: "tu-old"),
        ], cursor: .empty))
        guard case .toolCall(_, _, let historicalIsLive) = viewModel.displayItems[0] else {
            return XCTFail("expected historical tool call")
        }
        XCTAssertFalse(historicalIsLive)

        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamEntry(
            sessionId: "bks-1",
            entry: entry("live-tool", "tool_use", toolUseId: "tu-live")
        ))
        guard case .toolCall(_, _, let liveIsLive) = viewModel.displayItems.last else {
            return XCTFail("expected live tool call")
        }
        XCTAssertTrue(liveIsLive)
    }

    /// A tool call graduates the preceding live text into an ordered
    /// ephemeral entry, so the turn reads text → tool instead of the text
    /// dangling in the bottom bubble below the tool row.
    func testToolCallGraduatesPrecedingLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Let me check."))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-1", "tool_use", toolUseId: "tu-1")))
        XCTAssertEqual(viewModel.liveText, "", "text must leave the live bubble")
        XCTAssertEqual(viewModel.displayItems.count, 2)
        guard case .entry(let graduated) = viewModel.displayItems[0] else {
            return XCTFail("graduated text should render before the tool call")
        }
        XCTAssertEqual(graduated.text, "Let me check.")
        XCTAssertTrue(graduated.isAssistant)
        guard case .toolCall = viewModel.displayItems[1] else {
            return XCTFail("tool call should follow the graduated text")
        }
    }

    /// The durable copy of a graduated block replaces it without duplication.
    func testDurableAppendReplacesGraduatedLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Let me check."))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-1", "tool_use", toolUseId: "tu-1")))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Let me check."),
            entry("srv-1", "tool_use", toolUseId: "tu-1"),
        ]))
        XCTAssertTrue(viewModel.liveEntries.isEmpty, "graduated copy must not linger next to the durable one")
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "srv-1"])
        XCTAssertEqual(viewModel.displayItems.count, 2)
    }

    func testStreamEntryGraduatesWhenDurableCopyLands() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-5", "tool_use", toolUseId: "tu-5")))
        XCTAssertEqual(viewModel.liveEntries.count, 1)
        // Durable copy arrives under a different entry id but the same toolUseId.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("srv-5", "tool_use", toolUseId: "tu-5")
        ]))
        XCTAssertTrue(viewModel.liveEntries.isEmpty, "ephemeral copy must not linger next to the durable one")
        XCTAssertEqual(viewModel.entries.map(\.id), ["srv-5"])
        XCTAssertEqual(viewModel.displayItems.count, 1)
    }

    func testRunStopPreservesLiveTextUntilAppendLands() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "tail text"))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        XCTAssertFalse(viewModel.isRunning)
        XCTAssertFalse(viewModel.isStreaming)
        // Wiping here would blink the reply out before transcript_append lands.
        XCTAssertEqual(viewModel.liveText, "tail text")
    }

    func testQueueUpdate() {
        let viewModel = makeViewModel()
        // Drive this one through the raw frame so it also pins the wire parse.
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"next","user":"jaap"}],
         "steered":[{"id":"s1","content":"steer"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["s1"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testAskQuestionLifecycle() {
        let viewModel = makeViewModel()
        let question = AskQuestion(id: "ask-1", questions: [])
        viewModel.handle(.askQuestion(sessionId: "bks-1", question: question))
        XCTAssertEqual(viewModel.pendingQuestion?.id, "ask-1")
        viewModel.handle(.askResolved(sessionId: "bks-1", questionId: "ask-other"))
        XCTAssertNotNil(viewModel.pendingQuestion, "resolving a different question must not clear ours")
        viewModel.handle(.askResolved(sessionId: "bks-1", questionId: "ask-1"))
        XCTAssertNil(viewModel.pendingQuestion)
    }

    func testNoticeSetsAndClears() {
        let viewModel = makeViewModel()
        viewModel.handle(.notice("heads up"))
        XCTAssertEqual(viewModel.notice, "heads up")
        viewModel.handle(.notice(""))
        XCTAssertNil(viewModel.notice)
    }
}

/// `sendDraft` composer semantics: an idle send echoes an optimistic bubble
/// into the transcript; a send during a run is queued server-side (busyMode
/// "queue") and must surface as a queue chip, never a thread bubble — the
/// stranded out-of-order bubble is the bug these pin down.
@MainActor
final class SendDraftTests: XCTestCase {
    private var viewModel: SessionViewModel!
    private var socket: MockSocket!

    override func setUp() async throws {
        socket = MockSocket()
        let mock = socket!
        viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { mock }
        )
        viewModel.start()
    }

    private func entry(_ id: String, _ type: String, text: String? = nil) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text)
    }

    private func markRunning() {
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
    }

    // MARK: - Idle sends

    func testIdleSendEchoesOptimisticBubble() {
        viewModel.draft = "hi there"
        viewModel.sendDraft()
        XCTAssertEqual(viewModel.entries.count, 1)
        XCTAssertEqual(viewModel.entries[0].text, "hi there")
        XCTAssertTrue(viewModel.entries[0].isUser)
        XCTAssertEqual(viewModel.displayItems.count, 1)
        XCTAssertTrue(viewModel.queuedItems.isEmpty, "idle sends must not fabricate a queue chip")
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.draft, "")
        XCTAssertEqual(socket.prompts.count, 1)
        XCTAssertEqual(socket.prompts[0].content, "hi there")
    }

    func testIdleEchoReplacedByServerCopyWithoutDuplication() {
        viewModel.draft = "hi"
        viewModel.sendDraft()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"], "optimistic bubble must be replaced, not doubled")
    }

    func testWhitespaceOnlyDraftIsNotSent() {
        viewModel.draft = "   \n  "
        viewModel.sendDraft()
        XCTAssertTrue(socket.prompts.isEmpty)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
    }

    func testSendWithoutSocketKeepsDraft() {
        let offline = SessionViewModel(session: Session(id: "bks-1"))
        offline.draft = "hi"
        offline.sendDraft()
        XCTAssertEqual(offline.draft, "hi", "an unsent draft must not be discarded")
        XCTAssertTrue(offline.entries.isEmpty)
    }

    // MARK: - Busy sends (the queue-chip path)

    func testBusySendShowsQueueChipNotTranscriptBubble() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        XCTAssertTrue(viewModel.entries.isEmpty, "a queued send must not enter the transcript")
        XCTAssertTrue(viewModel.displayItems.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.count, 1)
        XCTAssertEqual(viewModel.queuedItems[0].content, "do this next")
        XCTAssertEqual(viewModel.queuedItems[0].user, ServerConfig.shared.userName)
        XCTAssertTrue(viewModel.queuedItems[0].id.hasPrefix("local-queued-"))
        XCTAssertEqual(viewModel.queuedCount, 1)
        // The frame still goes out — queueing is the server's job.
        XCTAssertEqual(socket.prompts.count, 1)
        XCTAssertEqual(socket.prompts[0].content, "do this next")
    }

    func testTwoBusySendsStackTwoChips() {
        markRunning()
        viewModel.draft = "first"
        viewModel.sendDraft()
        viewModel.draft = "second"
        viewModel.sendDraft()
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["first", "second"])
        XCTAssertEqual(viewModel.queuedCount, 2)
        XCTAssertTrue(viewModel.entries.isEmpty)
    }

    func testServerQueueUpdateReplacesLocalChip() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"], "server copy must replace the local chip, not join it")
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testQueuedMessageEntersTranscriptOnlyOnDelivery() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        // Run finishes, queue delivers: queue empties and the prompt lands as
        // a durable user entry — the thread shows it exactly once, in order.
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u9", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u9"])
        XCTAssertEqual(viewModel.displayItems.count, 1)
    }

    /// The race: the run ended in the gap, the server delivered the prompt
    /// straight to the engine, and no queue_update ever mentions it — the
    /// chip must retire when the durable user entry lands.
    func testBusySendDeliveredImmediatelyRetiresChip() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    func testChipRetirementMatchesByContent() {
        markRunning()
        viewModel.draft = "mine"
        viewModel.sendDraft()
        // Someone else's prompt (web UI, another device) landing must not
        // retire our chip.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "someone else's")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["mine"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testServerChipsAreNeverRetiredByContentMatch() {
        // A server-issued queue item (real id) with the same text as a landing
        // user entry must stay — only local optimistic chips retire this way.
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"repeat me","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "repeat me")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
    }

    func testBusySendCarriesImagesOnTheWire() {
        markRunning()
        viewModel.draft = "with pic"
        viewModel.attachedImages = [AttachedImage(id: "img1", jpegData: Data([1, 2, 3]))]
        viewModel.sendDraft()
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["with pic"])
        XCTAssertTrue(viewModel.attachedImages.isEmpty)
        XCTAssertEqual(socket.prompts.count, 1)
        XCTAssertEqual(socket.prompts[0].images?.count, 1)
    }

    func testDeleteQueuedRemovesChipAndSendsFrame() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"next","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.deleteQueued(viewModel.queuedItems[0])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(socket.deletedQueueIds, ["q1"])
    }

    // MARK: - Delivering hold state (the vanish-then-reappear bug)

    private func sendEmptyQueueUpdate() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
    }

    /// The core bug: the queue drain broadcasts the EMPTIED queue seconds
    /// before the delivered prompt lands via the ~1s file watcher. The chip
    /// must hold as "delivering" across that gap — the message is never
    /// absent from the UI.
    func testDrainedChipHoldsAsDeliveringUntilEchoLands() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        // Server registers the queued item (replaces the local chip).
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        // Run ends; the drain empties the queue BEFORE the transcript echo.
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["do this next"],
            "the message must stay visible while the echo is in flight"
        )
        // Echo lands: the delivering chip retires; exactly one copy remains.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u9", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u9"])
    }

    /// Race: a queue_update computed before our prompt reached the server
    /// (run ended in the gap; the prompt went straight to the engine) must
    /// not wipe the local chip — it holds as delivering until the entry lands.
    func testLocalChipSurvivesQueueUpdateThatOmitsIt() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["do this next"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// Steered/attributed deliveries land as "[user] content", and a
    /// multi-message drain joins the batch into ONE user entry — containment
    /// must retire every chip the entry covers (mirrors the server's own
    /// steer-receipt reconciliation).
    func testAttributedAndBatchedEchoRetiresDeliveringChips() {
        markRunning()
        viewModel.draft = "first"
        viewModel.sendDraft()
        viewModel.draft = "second"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["first", "second"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] first\n\n[jaap] second")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testDeliveringChipIgnoresUnrelatedUserEntry() {
        markRunning()
        viewModel.draft = "mine"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "someone else's")
        ]))
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["mine"])
    }

    /// A queue_update that re-lists a delivering chip's message (the prompt
    /// arrived after the drain frame was computed and got queued after all)
    /// moves it back to a live queue chip instead of duplicating it.
    func testRequeuedMessageLeavesDeliveringState() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        let requeued = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(requeued.utf8)))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
    }

    /// A resync's transcript_init is a full snapshot — no upsert runs on it,
    /// so a delivering chip whose message it already contains (attributed
    /// form here) must retire there instead of lingering.
    func testResyncInitRetiresDeliveredChip() {
        markRunning()
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ], cursor: .empty))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// Ghost protection: a chip whose echo never comes (deleted from another
    /// device, server restart) drops once the grace window passes — but not
    /// a moment before.
    func testDeliveringChipExpiresOnlyAfterGrace() {
        markRunning()
        viewModel.draft = "gone"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.pruneExpiredDelivering(
            now: Date().addingTimeInterval(viewModel.deliveringGrace - 5)
        )
        XCTAssertEqual(viewModel.deliveringItems.count, 1, "still within the grace window")
        viewModel.pruneExpiredDelivering(
            now: Date().addingTimeInterval(viewModel.deliveringGrace + 5)
        )
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    /// A re-send of an identical message must not be retired against the OLD
    /// copy in history: the drain holds it as delivering until ITS echo
    /// lands. (The whole-history containment scan dropped it immediately and
    /// blinked the message out — the steering vanish-then-reappear.)
    func testRepeatedSendHoldsAsDeliveringDespiteIdenticalOldMessage() {
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue"),
            entry("a1", "assistant", text: "done"),
        ], cursor: .empty))
        markRunning()
        viewModel.draft = "continue"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["continue"],
            "the old identical message must not count as this chip's echo"
        )
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u2", "user", text: "continue")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1", "a1", "u2"])
    }

    /// Same protection on the resync path: a snapshot that re-lists only
    /// entries we already hold must not retire a delivering chip — only a
    /// NEW entry (an id we didn't know) counts as its echo.
    func testResyncInitKeepsDeliveringChipAgainstOldIdenticalMessage() {
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ], cursor: .empty))
        markRunning()
        viewModel.draft = "continue"
        viewModel.sendDraft()
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["continue"],
            "an old identical entry in the snapshot is not this chip's echo"
        )
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue"),
            entry("u2", "user", text: "[jaap] continue"),
        ], cursor: .empty))
        XCTAssertTrue(
            viewModel.deliveringItems.isEmpty,
            "the snapshot carrying the NEW echo retires the chip"
        )
    }

    /// Echo-before-drain ordering: when the durable entry lands while the
    /// server still lists the chip as queued, the eventual drain drops the
    /// chip outright instead of resurrecting a delivered message as a
    /// "Delivering…" ghost.
    func testDrainDropsChipWhoseEchoAlreadyLanded() {
        markRunning()
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"], "server chips retire only via queue_update")
        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
    }

    /// The steer flow end-to-end: steered receipt → drain → attributed echo.
    /// The message must be visible at every step.
    func testSteeredChipHoldsAcrossDrainUntilEchoLands() {
        markRunning()
        let steered = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],
         "steered":[{"id":"s1","content":"go left","user":"jaap"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(steered.utf8)))
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["s1"])
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["go left"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] go left")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    // MARK: - Stale-busy sends (bubble ↔ queue reconciliation)

    /// A resync racing the ~1s persist of a just-delivered send must not wipe
    /// its optimistic bubble — the snapshot doesn't contain the message yet.
    func testResyncInitKeepsUnlandedOptimisticBubble() {
        viewModel.draft = "hi there"
        viewModel.sendDraft()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u0", "user", text: "earlier message")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.entries.map(\.text), ["earlier message", "hi there"],
            "the unlanded bubble must survive the snapshot"
        )
        // The echo then replaces the preserved bubble without duplication.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi there")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u0", "u1"])
    }

    func testResyncInitRetiresLandedOptimisticBubble() {
        viewModel.draft = "hi there"
        viewModel.sendDraft()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi there")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.entries.map(\.id), ["u1"],
            "a landed echo must replace the bubble, not join it"
        )
    }

    /// The stale-isRunning hole: the client thought the session idle (bubble
    /// echo), but the server was mid-run and QUEUED the prompt. The bubble
    /// converts to the server's queue chip — one representation, no thread
    /// copy for the next resync to wipe — and the message stays visible
    /// through drain and delivery.
    func testStaleBusySendConvertsBubbleToChipWhenServerQueuesIt() {
        viewModel.draft = "do this next"
        viewModel.sendDraft()
        XCTAssertEqual(viewModel.entries.map(\.text), ["do this next"])
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        XCTAssertTrue(viewModel.entries.isEmpty, "the queue chip now represents the message")
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        // A resync mid-queue has nothing to wipe — the chip carries on.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [], cursor: .empty))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        // Drain → delivering hold → attributed echo lands exactly once.
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["do this next"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }
}

/// Records every outgoing frame; never touches the network.
@MainActor
private final class MockSocket: SessionSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    struct PromptCall {
        let sessionId: String
        let content: String
        let user: String
        let images: [String]?
        let effort: String?
        let fastMode: Bool?
        let busyMode: String?
    }

    private(set) var connectCount = 0
    private(set) var disconnectCount = 0
    private(set) var watched: [String] = []
    private(set) var prompts: [PromptCall] = []
    private(set) var steeredQueueIds: [String] = []
    private(set) var deletedQueueIds: [String] = []

    func connect() { connectCount += 1 }
    func disconnect() { disconnectCount += 1 }
    func watch(sessionId: String) { watched.append(sessionId) }
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {}
    func loadHistory(sessionId: String, beforeSeq: Int) {}
    func prompt(
        sessionId: String, content: String, user: String,
        images: [String]?, effort: String?, fastMode: Bool?, busyMode: String?
    ) {
        prompts.append(PromptCall(
            sessionId: sessionId, content: content, user: user,
            images: images, effort: effort, fastMode: fastMode, busyMode: busyMode
        ))
    }
    func steerQueued(sessionId: String, queueId: String) { steeredQueueIds.append(queueId) }
    func deleteQueued(sessionId: String, queueId: String) { deletedQueueIds.append(queueId) }
    func cancelWatchedRun() {}
    func answer(sessionId: String, questionId: String, answers: [String: String]?) {}
}
