import CryptoKit
import Foundation

/// Unresolved REST create intents keyed by request identity. Each distinct
/// create keeps its own request id until that exact response is acknowledged.
struct SessionCreateIntent {
    private struct Stored: Codable {
        let version: Int
        var intents: [String: String]
    }

    private struct LegacyStored: Codable {
        let identity: String
        let requestId: String
    }

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String) {
        self.defaults = defaults
        self.key = key
    }

    func requestId(for body: [String: Any]) -> String {
        let identity = Self.identity(body)
        var stored = load()
        if let requestId = stored.intents[identity] { return requestId }
        let requestId = UUID().uuidString.lowercased()
        stored.intents[identity] = requestId
        save(stored)
        return requestId
    }

    func complete(requestId: String) {
        var stored = load()
        guard let identity = stored.intents.first(where: { $0.value == requestId })?.key
        else { return }
        stored.intents.removeValue(forKey: identity)
        if stored.intents.isEmpty { defaults.removeObject(forKey: key) }
        else { save(stored) }
    }

    private func load() -> Stored {
        guard let data = defaults.data(forKey: key) else {
            return Stored(version: 2, intents: [:])
        }
        if let stored = try? JSONDecoder().decode(Stored.self, from: data),
           stored.version == 2 {
            let migrated = migrateLegacyKeys(stored)
            if migrated.intents != stored.intents { save(migrated) }
            return migrated
        }
        if let legacy = try? JSONDecoder().decode(LegacyStored.self, from: data) {
            let stored = migrateLegacyKeys(
                Stored(version: 2, intents: [legacy.identity: legacy.requestId])
            )
            save(stored)
            return stored
        }
        return Stored(version: 2, intents: [:])
    }

    private func migrateLegacyKeys(_ stored: Stored) -> Stored {
        var intents: [String: String] = [:]
        for (identity, requestId) in stored.intents {
            if identity.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil {
                intents[identity] = requestId
            } else if let data = Data(base64Encoded: identity) {
                let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                intents[digest] = requestId
            } else {
                intents[identity] = requestId
            }
        }
        return Stored(version: 2, intents: intents)
    }

    private func save(_ stored: Stored) {
        if let data = try? JSONEncoder().encode(stored) { defaults.set(data, forKey: key) }
    }

    private static func identity(_ body: [String: Any]) -> String {
        var identityBody = body
        identityBody.removeValue(forKey: "requestId")
        guard let data = try? JSONSerialization.data(withJSONObject: identityBody, options: [.sortedKeys])
        else { return String(describing: identityBody) }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
