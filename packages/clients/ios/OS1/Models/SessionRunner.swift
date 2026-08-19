import Foundation

/// A persistent workspace Runner selected for a session. A Runner is a
/// trusted machine, not a Sandbox, so native UI keeps the two runtime shapes
/// visibly distinct.
struct SessionRunner: Decodable, Equatable, Hashable, Sendable {
    let id: String
    let name: String
    let workspacePath: String
    let lifecycle: String?
    let lastLifecycleError: String?
}
