import Foundation

/// The demo an agent publishes when it finishes a user-visible change: a short
/// screen recording, before/after stills, and a writeup. Mirrors the server's
/// `SessionWalkthrough` (src/server/types.ts) — every field but the timestamp
/// is optional, since a walkthrough can be writeup-only.
///
/// It rides on the session row rather than the transcript, and is placed into
/// the transcript by `TranscriptGrouping` at the point where it was published.
struct SessionWalkthrough: Decodable, Equatable, Hashable {
    /// Markdown: what changed, root cause for a fix, how it was verified.
    var summary: String = ""
    /// Absolute server-side path to the demo recording, if there is one.
    var video: String?
    var videoTitle: String?
    var shots: [WalkthroughShot]?
    var publishedAt: String = ""
    var publishedBy: String?
    /// Transcript entry of the `publish_walkthrough` call that produced this.
    /// The server records it at publish time — the one moment anything knows
    /// where the card belongs — so placement is a lookup rather than a scan.
    /// Absent on walkthroughs published before that field existed.
    var publishedEntryId: String?

    var publishedDate: Date? { Session.parseISO(publishedAt) }

    var stills: [WalkthroughShot] {
        (shots ?? []).filter { $0.before != nil || $0.after != nil }
    }
}

/// One before/after pair. Either side may be missing — an "after only" shot is
/// how a brand-new surface gets illustrated.
struct WalkthroughShot: Decodable, Equatable, Hashable, Identifiable {
    var before: String?
    var after: String?
    var caption: String?

    /// Stable within one walkthrough: the paths are distinct staged files.
    var id: String { "\(before ?? "")|\(after ?? "")" }
}
