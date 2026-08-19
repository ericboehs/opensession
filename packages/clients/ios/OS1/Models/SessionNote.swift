import Foundation

/// A human-to-human note interleaved into a session transcript. The agent
/// never receives it.
struct SessionNote: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let user: String
    let text: String
    let images: [String]?
    /// Milliseconds since 1970, matching the server store.
    let ts: Double
    let editedAt: Double?

    init(
        id: String,
        user: String,
        text: String,
        images: [String]? = nil,
        ts: Double,
        editedAt: Double? = nil
    ) {
        self.id = id
        self.user = user
        self.text = text
        self.images = images
        self.ts = ts
        self.editedAt = editedAt
    }

    var date: Date { Date(timeIntervalSince1970: ts / 1_000) }
}
