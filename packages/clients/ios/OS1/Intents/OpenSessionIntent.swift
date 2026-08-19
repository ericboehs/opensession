import AppIntents

struct OpenSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Session"
    static let openAppWhenRun = true

    @Parameter(title: "Session")
    var sessionId: String

    init() {
        sessionId = ""
    }

    init(sessionId: String) {
        self.sessionId = sessionId
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard !sessionId.isEmpty else { return .result() }
        SessionOpenRequest.shared.ask(sessionId: sessionId)
        return .result()
    }
}

@MainActor
@Observable
final class SessionOpenRequest {
    static let shared = SessionOpenRequest()

    struct Request: Identifiable {
        let id = UUID()
        let sessionId: String
    }

    private(set) var request: Request?

    func ask(sessionId: String) {
        request = Request(sessionId: sessionId)
    }

    func take() -> Request? {
        defer { request = nil }
        return request
    }
}
