import Foundation

/// Parsed server-to-client WebSocket frames. Frame types the client does not
/// care about yet decode to `.ignored` instead of failing, so protocol
/// additions on the server are harmless.
enum ServerEvent {
    case hello(bootId: String)
    case pong
    case transcriptInit(sessionId: String, entries: [TranscriptEntry])
    case transcriptHistory(sessionId: String, entries: [TranscriptEntry])
    case transcriptAppend(sessionId: String, entries: [TranscriptEntry])
    case streamStart(sessionId: String)
    case streamText(sessionId: String, text: String)
    case streamEntry(sessionId: String, entry: TranscriptEntry)
    case streamDone(sessionId: String)
    case sessionStatus(sessionId: String, isRunning: Bool)
    case queueUpdate(sessionId: String, count: Int)
    case askQuestion(sessionId: String, question: AskQuestion)
    case askResolved(sessionId: String, questionId: String)
    case notice(String)
    case serverError(String)
    case ignored

    static func parse(_ data: Data) -> ServerEvent {
        guard let frame = try? JSONDecoder().decode(RawFrame.self, from: data) else {
            return .ignored
        }
        switch frame.type {
        case "hello":
            return .hello(bootId: frame.bootId ?? "")
        case "pong":
            return .pong
        case "transcript_init":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptInit(sessionId: id, entries: frame.entries ?? [])
        case "transcript_history":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptHistory(sessionId: id, entries: frame.entries ?? [])
        case "transcript_append":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptAppend(sessionId: id, entries: frame.entries ?? [])
        case "stream_start":
            guard let id = frame.sessionId else { return .ignored }
            return .streamStart(sessionId: id)
        case "stream_text":
            guard let id = frame.sessionId, let text = frame.text else { return .ignored }
            return .streamText(sessionId: id, text: text)
        case "stream_tool_use", "stream_tool_result":
            guard let id = frame.sessionId, let entry = frame.entry else { return .ignored }
            return .streamEntry(sessionId: id, entry: entry)
        case "stream_done":
            guard let id = frame.sessionId else { return .ignored }
            return .streamDone(sessionId: id)
        case "session_status":
            guard let id = frame.sessionId else { return .ignored }
            return .sessionStatus(sessionId: id, isRunning: frame.isRunning ?? false)
        case "queue_update":
            guard let id = frame.sessionId else { return .ignored }
            return .queueUpdate(sessionId: id, count: frame.queued?.count ?? 0)
        case "ask_question":
            guard let id = frame.sessionId,
                  let questionId = frame.questionId,
                  let questions = frame.questions
            else { return .ignored }
            return .askQuestion(
                sessionId: id,
                question: AskQuestion(id: questionId, questions: questions)
            )
        case "ask_resolved":
            guard let id = frame.sessionId, let questionId = frame.questionId else {
                return .ignored
            }
            return .askResolved(sessionId: id, questionId: questionId)
        case "notice":
            return .notice(frame.message ?? "")
        case "error":
            return .serverError(frame.message ?? "Unknown server error")
        default:
            return .ignored
        }
    }
}

/// Superset of every server frame's fields; individual events pick what they need.
private struct RawFrame: Decodable {
    struct QueuedItem: Decodable {
        let id: String?
    }

    let type: String
    let sessionId: String?
    let bootId: String?
    let entries: [TranscriptEntry]?
    let entry: TranscriptEntry?
    let text: String?
    let isRunning: Bool?
    let queued: [QueuedItem]?
    let questionId: String?
    let questions: [AskQuestion.Question]?
    let message: String?
}
