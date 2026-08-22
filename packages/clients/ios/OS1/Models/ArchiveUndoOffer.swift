import Foundation

/// One archive action and the exact sessions it can restore while visible.
struct ArchiveUndoOffer: Identifiable, Equatable {
    let id: UUID
    let sessions: [Session]
    let expiresAt: Date

    var message: String {
        sessions.count == 1 ? "Archived" : "Archived \(sessions.count) sessions"
    }
}
