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
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "hi"),
            entry("e2", "assistant", text: "hello"),
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
        XCTAssertEqual(viewModel.displayItems.map(\.id), ["e1", "e2"])
    }

    func testEventsForOtherSessionsAreIgnored() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-other", entries: [entry("x", "user")]))
        viewModel.handle(.streamStart(sessionId: "bks-other"))
        viewModel.handle(.streamText(sessionId: "bks-other", text: "nope"))
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
        ]))
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
        ]))
        XCTAssertTrue(viewModel.liveText.contains("And more"))
        XCTAssertFalse(viewModel.liveText.contains("Hello world."))
    }

    func testHistoryPrependsWithoutDuplicates() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [entry("e2", "user", text: "recent")]))
        viewModel.handle(.transcriptHistory(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "older"),
            entry("e2", "user", text: "recent"),
        ]))
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
        ]))
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
        // QueueItem is only constructible from the wire (by design), so drive
        // this one through the raw frame.
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
