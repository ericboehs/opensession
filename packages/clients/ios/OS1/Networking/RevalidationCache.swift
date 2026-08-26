import Foundation

/// What lets a poll that changed nothing cost nothing.
///
/// The sessions list is by far the largest thing this app reads, and it is
/// read again every five seconds. The server already answers a conditional
/// request for it with a 304 (`sessionsListResponse`, src/server/routes/
/// sessions.ts), and a browser takes that offer for free. URLSession does not:
/// it only revalidates bodies small enough for `URLCache` to have kept, and
/// this one is far past that, so the app was downloading megabytes on every
/// tick for a response the server would have declined to send.
///
/// So the validator is kept here, beside the value it came with. A hit skips
/// the transfer and the decode both, and hands back a value equal to the one
/// published last time, which is what lets `SessionsListViewModel` skip its
/// grouping pass as well.
///
/// Only the polled lists opt in, through `OS1API.get(_:revalidating:)`.
/// Remembering every response this app reads would be a leak wearing a nice
/// name; two entries that replace what the poll was allocating anyway is not.
@MainActor
final class RevalidationCache {
    static let shared = RevalidationCache()

    private struct Entry {
        let etag: String
        let value: any Sendable
    }

    /// Which server and token the stored bodies were answered for. Everything
    /// is dropped when it changes: an ETag means nothing across servers, and
    /// one account's rows must never answer another's request.
    private var connection: String?
    private var entries: [String: Entry] = [:]

    /// The validator to send for `path`, or nil when there is nothing stored
    /// to fall back on. An ETag is never offered without its body: a 304 this
    /// cache cannot answer costs a round trip and gives nothing back.
    func validator(for path: String, connection: String) -> String? {
        sync(connection)
        return entries[path]?.etag
    }

    /// The body the last response for `path` decoded to, if it is still the
    /// type being asked for. A mismatch reads as a miss rather than a trap.
    func value<T>(_ type: T.Type, for path: String) -> T? {
        entries[path]?.value as? T
    }

    func store(
        _ value: any Sendable,
        etag: String,
        for path: String,
        connection: String
    ) {
        sync(connection)
        entries[path] = Entry(etag: etag, value: value)
    }

    /// Drops what `path` remembers, so its next request goes out plain.
    func forget(_ path: String) {
        entries.removeValue(forKey: path)
    }

    func removeAll() {
        entries.removeAll()
        connection = nil
    }

    private func sync(_ connection: String) {
        guard connection != self.connection else { return }
        self.connection = connection
        entries.removeAll()
    }
}
