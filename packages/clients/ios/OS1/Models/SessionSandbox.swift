import Foundation

/// The sandbox recorded on a session row. Provider fields are optional because
/// session records and servers can predate sandbox materialization.
struct SessionSandbox: Decodable, Equatable, Hashable, Sendable {
    let provider: String?
    let sandboxId: String?
    let workspace: String?
    let lifecycle: String?
    let lastLifecycleError: String?
}

/// Live state from `GET /api/sessions/:id/sandbox`. Keep every field optional:
/// a new provider state or a server rollout must not make an older client fail
/// to decode a session's workspace details.
struct SessionSandboxStatus: Decodable, Equatable, Sendable {
    struct Logs: Decodable, Equatable, Sendable {
        let setup: String?
        let resume: String?
    }

    let enabled: Bool?
    let provider: String?
    let sandboxId: String?
    let workspace: String?
    let status: String?
    let lifecycle: String?
    let lastLifecycleError: String?
    let materialized: Bool?
    let busy: Bool?
    let cwd: String?
    let canPause: Bool?
    let canResume: Bool?
    let logs: Logs?
}

enum SessionSandboxAction: String, Equatable {
    case pause, resume, recreate
}
