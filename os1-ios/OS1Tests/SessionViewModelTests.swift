import XCTest
@testable import OS1

/// State-machine tests for `SessionViewModel.handle`: the dedupe dance between
/// the ephemeral stream channel (stream_text / stream_tool_*) and the durable
/// transcript channel (transcript_append / resync transcript_init) is where
/// every "text renders twice" bug has lived — each case here pins one of them.
@MainActor
final class SessionViewModelTests: XCTestCase {
    private func makeViewModel() -> SessionViewModel {
        SessionViewModel(session: Session(id: "bks-1"))
    }

    private func entry(
        _ id: String, _ type: String, text: String? = nil, toolUseId: String? = nil
    ) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text, toolUseId: toolUseId)
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
        guard case .toolCall(let use, let result) = viewModel.displayItems[0] else {
            return XCTFail("expected merged tool call")
        }
        XCTAssertEqual(use.id, "e1")
        XCTAssertEqual(result?.text, "ok")
        guard case .entry(let orphan) = viewModel.displayItems[1] else {
            return XCTFail("orphan tool_result should render standalone")
        }
        XCTAssertEqual(orphan.id, "tr-orphan")
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
    }

    private(set) var connectCount = 0
    private(set) var watched: [String] = []
    private(set) var prompts: [PromptCall] = []
    private(set) var steeredQueueIds: [String] = []
    private(set) var deletedQueueIds: [String] = []

    func connect() { connectCount += 1 }
    func disconnect() {}
    func watch(sessionId: String) { watched.append(sessionId) }
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {}
    func loadHistory(sessionId: String, beforeSeq: Int) {}
    func prompt(
        sessionId: String, content: String, user: String,
        images: [String]?, effort: String?, fastMode: Bool?
    ) {
        prompts.append(PromptCall(
            sessionId: sessionId, content: content, user: user,
            images: images, effort: effort, fastMode: fastMode
        ))
    }
    func steerQueued(sessionId: String, queueId: String) { steeredQueueIds.append(queueId) }
    func deleteQueued(sessionId: String, queueId: String) { deletedQueueIds.append(queueId) }
    func cancelWatchedRun() {}
    func answer(sessionId: String, questionId: String, answers: [String: String]?) {}
}
