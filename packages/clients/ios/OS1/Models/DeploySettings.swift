import Foundation

/// Settings → Deploys: the internal web apps agents published with
/// `opensession-publish`.
///
/// They outlive the session that built them, so this is where a person sees
/// what is running and turns it off. Everything is optional, as everywhere
/// else in this client: a server that predates a field still decodes.
struct DeployVersion: Codable, Sendable, Equatable, Identifiable {
    var version: Int?
    var createdAt: String?
    var createdBy: String?
    var sessionId: String?
    var entrypoint: String?

    var id: Int { version ?? 0 }
}

struct DeployApp: Codable, Sendable, Equatable, Identifiable {
    var id: String?
    var name: String?
    var owner: String?
    var sessionId: String?
    var detail: String?
    var port: Int?
    var currentVersion: Int?
    var versions: [DeployVersion]?
    /// "running", "stopped" or "crashed".
    var state: String?
    var lastError: String?
    var createdAt: String?
    var updatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, owner, sessionId, port, currentVersion, versions, state
        case lastError, createdAt, updatedAt
        case detail = "description"
    }

    var isRunning: Bool { state == "running" }

    /// Whether rolling back has anywhere to go.
    var canRollBack: Bool { (currentVersion ?? 1) > 1 }

    /// The path it is served at, behind the same sign-in as the app itself.
    var path: String { "/d/\(name ?? "")/" }

    /// The line under the name: who published it, which version is live, and
    /// the failure if it has one.
    var summary: String {
        var parts: [String] = []
        if let detail, detail.isEmpty == false { parts.append(detail) }
        if let owner, owner.isEmpty == false { parts.append(owner) }
        if let currentVersion { parts.append("v\(currentVersion)") }
        if let lastError, lastError.isEmpty == false { parts.append(lastError) }
        return parts.joined(separator: " · ")
    }
}

struct DeploysResponse: Codable, Sendable {
    var deploys: [DeployApp]?
}

struct DeployResponse: Codable, Sendable {
    var deploy: DeployApp?
}
