import Foundation

/// Settings → Keychain: the credentials a person lends to their sessions, and
/// what has been lent out.
///
/// The server never returns a secret (`KeychainCredentialMeta` in
/// src/server/keychain.ts), so nothing here can hold one. A grant's id IS the
/// broker bearer token, which is why a grant row offers revoking and never
/// copying.
struct KeychainCredential: Codable, Sendable, Identifiable, Equatable {
    struct Injection: Codable, Sendable, Equatable {
        var header: String?
        var scheme: String?
    }

    var id: String?
    /// The roster first name of whoever approves asks for it.
    var owner: String?
    /// Lookup and display key, e.g. "vercel".
    var service: String?
    var detail: String?
    /// Broker target host, https assumed.
    var host: String?
    var injection: Injection?
    /// Empty means every method is allowed.
    var allowedMethods: [String]?
    /// Empty means every path is allowed.
    var allowedPathPrefixes: [String]?
    var createdAt: String?
    var updatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, owner, service, host, injection, allowedMethods, allowedPathPrefixes
        case createdAt, updatedAt
        // Every Swift type already answers to `description`, so the wire name
        // is mapped rather than shadowing it.
        case detail = "description"
    }

    /// What the row says under the service name: where the secret is sent, and
    /// how narrowly it is scoped.
    var scopeSummary: String {
        var parts: [String] = []
        if let host, host.isEmpty == false { parts.append(host) }
        let methods = (allowedMethods ?? []).filter { $0.isEmpty == false }
        parts.append(methods.isEmpty ? "any method" : methods.joined(separator: ", "))
        let prefixes = (allowedPathPrefixes ?? []).filter { $0.isEmpty == false }
        if prefixes.isEmpty == false { parts.append(prefixes.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

/// One lending of a credential to one session. `mode` is what it costs the
/// owner: "once" is a single use, "standing" lasts until it expires.
struct KeychainGrant: Codable, Sendable, Identifiable, Equatable {
    var id: String?
    var credentialId: String?
    var owner: String?
    var sessionId: String?
    var requestedBy: String?
    var purpose: String?
    var mode: String?
    var status: String?
    var createdAt: String?
    var expiresAt: String?
    var usedAt: String?
    var revokedAt: String?
    var askId: String?

    /// Only an active grant can be revoked; the rest are history.
    var isActive: Bool { status == "active" }
}

/// A session asking for a credential it has not been given. The approving
/// happens on the question card in the session, not here — this page only says
/// that something is waiting.
struct KeychainAsk: Codable, Sendable, Identifiable, Equatable {
    var id: String?
    var credentialId: String?
    var owner: String?
    var sessionId: String?
    var requestedBy: String?
    var purpose: String?
    var requestedMode: String?
    var status: String?
    var createdAt: String?

    var isPending: Bool { status == "pending" }
}

struct KeychainResponse: Codable, Sendable, Equatable {
    var credentials: [KeychainCredential]?
    var grants: [KeychainGrant]?
    var asks: [KeychainAsk]?
}

struct KeychainCredentialResponse: Codable, Sendable {
    var credential: KeychainCredential?
}
