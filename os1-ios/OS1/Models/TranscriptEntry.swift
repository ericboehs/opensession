import Foundation

/// One transcript entry, as returned by `GET /api/sessions/:id/transcript` and
/// carried inside WS `transcript_*` / `stream_tool_*` frames.
///
/// `toolInput` is arbitrary JSON and not decoded in this version; `toolName`
/// is enough to render a compact tool row.
struct TranscriptEntry: Identifiable, Decodable, Equatable {
    let id: String
    let type: String // "user" | "assistant" | "tool_use" | "tool_result" | "system"
    var content: String?
    var timestamp: String?
    var toolName: String?
    var isError: Bool?
    var model: String?
    var agentId: String?
    var contentClamped: Bool?
    var contentLength: Int?

    var text: String { content ?? "" }

    var timestampDate: Date? {
        Session.parseISO(timestamp)
    }

    var isUser: Bool { type == "user" }
    var isAssistant: Bool { type == "assistant" }
    var isTool: Bool { type == "tool_use" || type == "tool_result" }
    var isSystem: Bool { type == "system" }
}
