import XCTest
@testable import OS1

/// Wire-format tests: raw server JSON frames → `ServerEvent.parse`. These pin
/// the protocol contract with the backstage server (ws-handlers.ts), so a
/// field rename on either side fails here instead of silently decoding to
/// `.ignored` in production.
final class ServerEventTests: XCTestCase {
    private func parse(_ json: String) -> ServerEvent {
        ServerEvent.parse(Data(json.utf8))
    }

    func testHello() {
        guard case .hello(let bootId) = parse(#"{"type":"hello","bootId":"boot-1"}"#) else {
            return XCTFail("expected .hello")
        }
        XCTAssertEqual(bootId, "boot-1")
    }

    func testPong() {
        guard case .pong = parse(#"{"type":"pong"}"#) else {
            return XCTFail("expected .pong")
        }
    }

    func testTranscriptInitDecodesEntries() {
        let json = #"""
        {"type":"transcript_init","sessionId":"bks-1","entries":[
          {"id":"e1","type":"user","content":"hi","timestamp":"2026-07-23T10:00:00Z"},
          {"id":"e2","type":"assistant","content":"hello","model":"claude"},
          {"id":"e3","type":"tool_use","toolName":"bash","toolUseId":"tu-1",
           "toolInput":{"command":"ls","timeout":5}},
          {"id":"tr-tu-1","type":"tool_result","toolUseId":"tu-1","content":"ok","isError":false}
        ]}
        """#
        guard case .transcriptInit(let id, let entries, _) = parse(json) else {
            return XCTFail("expected .transcriptInit")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(entries.count, 4)
        XCTAssertTrue(entries[0].isUser)
        XCTAssertEqual(entries[0].text, "hi")
        XCTAssertNotNil(entries[0].timestampDate)
        XCTAssertTrue(entries[1].isAssistant)
        XCTAssertEqual(entries[2].toolName, "bash")
        XCTAssertEqual(entries[2].toolInput?["command"]?.stringValue, "ls")
        XCTAssertEqual(entries[3].toolUseId, "tu-1")
        XCTAssertEqual(entries[3].isError, false)
    }

    func testTranscriptFramesWithoutSessionIdAreIgnored() {
        for type in ["transcript_init", "transcript_history", "transcript_append",
                     "stream_start", "stream_done", "session_status", "queue_update"] {
            guard case .ignored = parse(#"{"type":"\#(type)"}"#) else {
                return XCTFail("\(type) without sessionId should be .ignored")
            }
        }
    }

    func testStreamText() {
        guard case .streamText(let id, let text) =
            parse(#"{"type":"stream_text","sessionId":"bks-1","text":"chunk"}"#)
        else { return XCTFail("expected .streamText") }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(text, "chunk")
        guard case .ignored = parse(#"{"type":"stream_text","sessionId":"bks-1"}"#) else {
            return XCTFail("stream_text without text should be .ignored")
        }
    }

    func testStreamToolFramesBecomeStreamEntry() {
        let json = #"""
        {"type":"stream_tool_use","sessionId":"bks-1",
         "entry":{"id":"e9","type":"tool_use","toolName":"read","toolUseId":"tu-9"}}
        """#
        guard case .streamEntry(let id, let entry) = parse(json) else {
            return XCTFail("expected .streamEntry")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(entry.toolUseId, "tu-9")
    }

    func testSessionStatus() {
        guard case .sessionStatus(_, let running) =
            parse(#"{"type":"session_status","sessionId":"bks-1","isRunning":true}"#)
        else { return XCTFail("expected .sessionStatus") }
        XCTAssertTrue(running)
        // Missing isRunning defaults to false rather than failing the frame.
        guard case .sessionStatus(_, let defaulted) =
            parse(#"{"type":"session_status","sessionId":"bks-1"}"#)
        else { return XCTFail("expected .sessionStatus") }
        XCTAssertFalse(defaulted)
    }

    func testQueueUpdate() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this","user":"jaap"},{}],
         "steered":[{"id":"s1","content":"steer"}]}
        """#
        guard case .queueUpdate(_, let queued, let steered) = parse(json) else {
            return XCTFail("expected .queueUpdate")
        }
        XCTAssertEqual(queued.count, 2)
        XCTAssertEqual(queued[0].content, "do this")
        XCTAssertEqual(queued[0].user, "jaap")
        // Empty wire item still yields a usable row (generated id, empty content).
        XCTAssertFalse(queued[1].id.isEmpty)
        XCTAssertEqual(queued[1].content, "")
        XCTAssertEqual(steered.map(\.id), ["s1"])
    }

    func testAskQuestionAndResolved() {
        let json = #"""
        {"type":"ask_question","sessionId":"bks-1","questionId":"ask-1","questions":[
          {"question":"Merge?","header":"PR","multiSelect":false,
           "options":[{"label":"Yes","description":"ship it"},{"label":"No"}]}
        ]}
        """#
        guard case .askQuestion(let id, let question) = parse(json) else {
            return XCTFail("expected .askQuestion")
        }
        XCTAssertEqual(id, "bks-1")
        XCTAssertEqual(question.id, "ask-1")
        XCTAssertEqual(question.questions.first?.options?.count, 2)

        guard case .askResolved(_, let questionId) =
            parse(#"{"type":"ask_resolved","sessionId":"bks-1","questionId":"ask-1"}"#)
        else { return XCTFail("expected .askResolved") }
        XCTAssertEqual(questionId, "ask-1")
    }

    func testNoticeAndError() {
        guard case .notice(let message) = parse(#"{"type":"notice","message":"heads up"}"#) else {
            return XCTFail("expected .notice")
        }
        XCTAssertEqual(message, "heads up")
        guard case .serverError(let error) = parse(#"{"type":"error"}"#) else {
            return XCTFail("expected .serverError")
        }
        XCTAssertEqual(error, "Unknown server error")
    }

    func testUnknownAndMalformedFramesAreIgnored() {
        guard case .ignored = parse(#"{"type":"future_frame","payload":123}"#) else {
            return XCTFail("unknown frame types must decode to .ignored")
        }
        guard case .ignored = parse("not json at all") else {
            return XCTFail("malformed frames must decode to .ignored")
        }
    }
}
