import Foundation
import Observation

/// What makes the transcript's link registries visible to SwiftUI.
///
/// `SessionLinks`, `PrLinks`, `FileLinks` and `AssetLinks` are plain static
/// tables, filled from the polled sessions list and from a session's own tool
/// calls. Nothing observed them, so a transcript rendered BEFORE those tables
/// were filled kept whatever it could make of empty ones — a PR mention stayed
/// prose, a session id wore its shortened id instead of the worker's title —
/// and stayed that way until something unrelated forced the row to redraw.
///
/// A cold deep link is exactly that case, and the only one a reader meets: a
/// push notification or `OS1_OPEN_SESSION` opens the conversation first and
/// polls second, so the first thing drawn is the version with no chips in it.
///
/// Registration bumps `generation`, and `MarkdownBody` reads it while building
/// a row, so the rows on screen re-run their rewrites when a table gains
/// something. Two things already in place keep that cheap enough to do
/// globally rather than per row: every `register` returns early unless the
/// table actually changed, and a re-run that produces the same markdown as
/// last time is discarded by `MarkdownView`'s `.task(id: text)` without
/// re-parsing. Only a row whose text really did gain a chip pays for one.
@MainActor
@Observable
final class TranscriptLinks {
    static let shared = TranscriptLinks()

    /// Bumped whenever one of the registries gains or changes an entry. The
    /// value itself means nothing; reading it is how a view subscribes.
    private(set) var generation: Int = 0

    /// Wraps around rather than trapping. A counter that overflows after 9
    /// quintillion polls is not a state worth crashing a reader's transcript
    /// over, and every consumer only compares it to its own last value.
    func invalidate() {
        generation &+= 1
    }

    private init() {}
}
