import Foundation

/// The effective configuration a session's next turn would use.
///
/// The server returns named sections whose rows all share one shape. Values
/// stay as `JSONValue` because account picks, presets, scopes, and policy rows
/// deliberately have different schemas. Every field is optional so a newer or
/// older server can add or omit a section without breaking Workspace Info.
struct SessionEffectiveConfig: Decodable, Equatable, Sendable {
    let session: EffectiveConfigSession?
    let resolvedAt: String?
    let caveat: String?
    let execution: EffectiveConfigSection?
    let gate: EffectiveConfigSection?
    let model: EffectiveConfigSection?
    let account: EffectiveConfigSection?
    let mcp: EffectiveMCPConfig?
    let tools: EffectiveConfigSection?
    let agents: EffectiveConfigSection?
    let memory: EffectiveConfigSection?
    let placement: EffectiveConfigSection?
    let identity: EffectiveConfigSection?
    let instructions: EffectiveConfigSection?
}

typealias EffectiveConfigSection = [String: EffectiveConfigRow]

struct EffectiveConfigSession: Decodable, Equatable, Sendable {
    let id: String?
    let title: String?
    let source: String?
    let workspaceId: String?
    let repo: String?
    let automation: String?
    let goalId: String?
    let archived: Bool?
}

struct EffectiveConfigRow: Decodable, Equatable, Sendable {
    let value: JSONValue?
    let source: String?
    let stability: String?
    let note: String?
}

struct EffectiveMCPConfig: Decodable, Equatable, Sendable {
    let scope: EffectiveConfigRow?
    let servers: [EffectiveMCPServer]?
    let inProcess: EffectiveConfigSection?
}

struct EffectiveMCPServer: Decodable, Equatable, Sendable {
    let name: String
    let included: Bool?
    let reason: String?
    let source: String?
    let transport: String?
    let allowedUsers: [String]?
    let oauthGrant: Bool?
}

struct EffectiveStrippedTool: Equatable, Sendable {
    let tool: String
    let ids: [String]
    let source: String?
    let reason: String?

    init?(value: JSONValue) {
        guard case .object(let object) = value,
              let tool = object["tool"]?.stringValue
        else { return nil }
        self.tool = tool
        if case .array(let values) = object["ids"] {
            ids = values.compactMap(\.stringValue)
        } else {
            ids = []
        }
        source = object["source"]?.stringValue
        reason = object["reason"]?.stringValue
    }
}
