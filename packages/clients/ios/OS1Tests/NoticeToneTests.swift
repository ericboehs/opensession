import XCTest
@testable import OS1

/// The composer chip and the transcript's notice row both colour a bare
/// string, so these pin the wording the server actually sends — the anchored
/// phrasings mirrored from `packages/core/protocol/src/notices.ts`.
final class NoticeToneTests: XCTestCase {
    func testServerPhrasingsKeepTheirTone() {
        XCTAssertEqual(NoticeTone.derived(fromText: "App update paused. No action needed."), .warn)
        XCTAssertEqual(NoticeTone.derived(fromText: "Sandbox unavailable; using the host"), .warn)
        XCTAssertEqual(NoticeTone.derived(fromText: "Couldn't switch to code mode"), .warn)
        XCTAssertEqual(NoticeTone.derived(fromText: "Run failed: engine exited"), .error)
        XCTAssertEqual(NoticeTone.derived(fromText: "Stopped after 30 minutes"), .error)
        XCTAssertEqual(
            NoticeTone.derived(fromText: "Workspace is gone and there is no host fallback"),
            .error
        )
    }

    func testOrdinaryLinesStayQuiet() {
        XCTAssertEqual(NoticeTone.derived(fromText: "Switched to code mode"), .info)
        XCTAssertEqual(NoticeTone.derived(fromText: "Model set to claude-opus-5"), .info)
        XCTAssertEqual(NoticeTone.derived(fromText: ""), .info)
    }

    /// An anchored phrase beats the loose keyword scan: "couldn't" is a warn
    /// even though the fallback would read "could not" as a failure.
    func testAnchoredPhraseBeatsTheKeywordScan() {
        XCTAssertEqual(
            NoticeTone.derived(fromText: "Couldn't reach the sandbox; could not mount"),
            .warn
        )
    }

    func testUnrecognisedFailuresStillReadAsFailures() {
        XCTAssertEqual(NoticeTone.derived(fromText: "Upload failed"), .error)
        XCTAssertEqual(NoticeTone.derived(fromText: "Turn interrupted"), .warn)
    }

    /// Only an error is worth keeping on screen; the rest retire themselves.
    func testOnlyErrorsPersist() {
        XCTAssertNil(NoticeTone.error.autoDismissAfter)
        XCTAssertNotNil(NoticeTone.warn.autoDismissAfter)
        XCTAssertNotNil(NoticeTone.info.autoDismissAfter)
    }
}
