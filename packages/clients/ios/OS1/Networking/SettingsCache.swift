import Foundation

/// Last-known settings payloads, so a settings screen opens on what it showed
/// last time instead of on a spinner.
///
/// Every settings pane fetches on `.task` and keeps the result in `@State`,
/// which dies the moment the pane is popped — so walking back into Preferences
/// or Connections paid for a full round trip, with the content blanked, every
/// single time. Each pane now seeds its state from here and refreshes in the
/// background: what you saw last is on screen immediately and is replaced by
/// the server's answer when it lands. A pane still shows its spinner when there
/// is genuinely nothing cached — first run, or the first look at that pane on
/// this device.
///
/// Entries are scoped to the connection that produced them (server + person),
/// so pointing the app at another instance or signing in as someone else can
/// never surface the previous account's settings; a scope change drops
/// everything. They live in the caches directory, which means the system may
/// evict them and nothing is lost when it does — this is a display cache, never
/// a source of truth, and never used to decide what to WRITE back (each pane's
/// save path still diffs against what the server last confirmed).
///
// Deliberately not actor-isolated, for the same reason as ServerConfig: views
// read it from nonisolated `@State` initializers, which is the whole point —
// seeding in `.task` instead would render one frame of the empty state first.
// Access to the in-memory table is serialized by a lock; the disk is only
// touched inside it or from a detached write.
enum SettingsCache {
    static func value<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        guard let data = store.data(for: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func save<T: Encodable>(_ key: String, _ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        store.write(data, for: key)
    }

    /// Forget everything — signing out, or an expired session.
    static func clear() { store.clear() }

    private static let store = Store()
}

private final class Store: @unchecked Sendable {
    private let lock = NSLock()
    /// Entries already read from disk this launch, keyed by cache key.
    private var memory: [String: Data] = [:]
    /// Which connection `memory` belongs to; a mismatch empties it.
    private var loadedScope: String?

    func data(for key: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        syncScope()
        if let cached = memory[key] { return cached }
        guard let stored = try? Data(contentsOf: fileURL(for: key)) else { return nil }
        memory[key] = stored
        return stored
    }

    func write(_ data: Data, for key: String) {
        lock.lock()
        syncScope()
        memory[key] = data
        let url = fileURL(for: key)
        lock.unlock()
        // Nothing on screen waits for this, so the caller shouldn't wait for
        // the disk either.
        Task.detached(priority: .utility) {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: url, options: .atomic)
        }
    }

    func clear() {
        lock.lock()
        memory = [:]
        loadedScope = Store.scope()
        let directory = Store.directoryURL(for: Store.scope())
        lock.unlock()
        purge(directory)
    }

    /// Drops everything the moment the connection or the person changes, so a
    /// pane can never be seeded from another account's answer. Caller holds the
    /// lock.
    private func syncScope() {
        let current = Store.scope()
        guard loadedScope != current else { return }
        let previous = loadedScope
        loadedScope = current
        memory = [:]
        // On the first call of a launch there is nothing to purge: whatever is
        // on disk already sits under the scope directory it was written for.
        if let previous {
            purge(Store.directoryURL(for: previous))
        }
    }

    private func purge(_ directory: URL) {
        Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    private func fileURL(for key: String) -> URL {
        Store.directoryURL(for: Store.scope())
            .appendingPathComponent("\(Store.safeName(key)).json")
    }

    private static func scope() -> String {
        let config = ServerConfig.shared
        let login = config.githubLogin
        let person = login.isEmpty ? "user:\(config.userName)" : "github:\(login)"
        return "\(config.baseURLString)|\(person)"
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private static func directoryURL(for scope: String) -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base
            .appendingPathComponent("os1-settings-cache", isDirectory: true)
            .appendingPathComponent(safeName(scope), isDirectory: true)
    }

    /// A stable, filesystem-safe name. Hashing would not survive a relaunch
    /// (Swift seeds `hashValue` per process), so the characters a path can't
    /// hold are simply replaced.
    private static func safeName(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let escaped = String(
            String.UnicodeScalarView(raw.unicodeScalars.map { allowed.contains($0) ? $0 : "-" })
        )
        return escaped.isEmpty ? "default" : String(escaped.suffix(120))
    }
}
