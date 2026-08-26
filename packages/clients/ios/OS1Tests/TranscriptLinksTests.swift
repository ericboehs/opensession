import XCTest
@testable import OS1

/// The transcript's chips come from static tables that SwiftUI cannot see. A
/// cold deep link draws the conversation before those tables are filled, so
/// what matters is that filling one is loud enough to redraw the rows that
/// were drawn without it.
@MainActor
final class TranscriptLinksTests: XCTestCase {
    private let id = "os-019fcead-adc4-7000-b0da-8a5af66819c7"

    override func setUp() async throws {
        SessionLinks.register(titles: [:])
        PrLinks.register(repos: [:])
    }

    /// The cold deep link, in miniature: render against an empty table, fill
    /// it, and the same markdown has to come out different.
    func testATitleArrivingChangesWhatTheRowRenders() {
        let source = "handed to `\(id)`"
        let before = chipsAsLinks(SessionLinks.linkify(source))
        XCTAssertTrue(before.contains("os-019fcead…"), before)

        let generation = TranscriptLinks.shared.generation
        SessionLinks.register(titles: [id: "Fold consecutive edits into one row"])

        XCTAssertGreaterThan(TranscriptLinks.shared.generation, generation)
        XCTAssertEqual(
            chipsAsLinks(SessionLinks.linkify(source)),
            "handed to [Fold consecutive edits into one row](os1session:\(id))"
        )
    }

    /// Without a repo table a mention has nowhere to point, so a PR chip is
    /// absent rather than merely unstyled — the case with the most visible
    /// difference between a cold transcript and a warm one.
    func testAPrMentionOnlyChipsOnceTheReposAreKnown() {
        XCTAssertEqual(PrLinks.linkify("opened opensession#128", sessionId: nil),
                       "opened opensession#128")

        let generation = TranscriptLinks.shared.generation
        PrLinks.register(repos: ["opensession": "tellahq/opensession"])

        XCTAssertGreaterThan(TranscriptLinks.shared.generation, generation)
        XCTAssertTrue(
            chipsAsLinks(PrLinks.linkify("opened opensession#128", sessionId: nil))
                .contains("(os1pr:opensession/128)")
        )
    }

    /// The counter rides every poll, so a poll that changed nothing must not
    /// redraw every transcript on screen.
    func testRegisteringTheSameTableAgainIsSilent() {
        SessionLinks.register(titles: [id: "Fold consecutive edits into one row"])
        PrLinks.register(repos: ["opensession": "tellahq/opensession"])

        let generation = TranscriptLinks.shared.generation
        SessionLinks.register(titles: [id: "Fold consecutive edits into one row"])
        PrLinks.register(repos: ["opensession": "tellahq/opensession"])

        XCTAssertEqual(TranscriptLinks.shared.generation, generation)
    }

    /// Paths are registered per session from that session's own tool calls,
    /// which land after the transcript on a cold open just as the poll does.
    func testAPathArrivingIsLoudToo() {
        let session = "os-019fcead-adc4-7000-b0da-8a5af66819c8"
        FileLinks.register(paths: [], for: session)

        let generation = TranscriptLinks.shared.generation
        FileLinks.register(paths: ["src/server/notes.ts"], for: session)

        XCTAssertGreaterThan(TranscriptLinks.shared.generation, generation)
    }
}
