import XCTest
@testable import OS1

final class TurnActivityTests: XCTestCase {
    func testLegacyPreferencesMapToTheSplitControls() {
        XCTAssertEqual(
            TurnActivity(work: "auto", tools: nil),
            TurnActivity(work: .running, tools: .folded)
        )
        XCTAssertEqual(
            TurnActivity(work: "expanded", tools: nil),
            TurnActivity(work: .open, tools: .open)
        )
    }

    func testStepTimingAndGroupedToolCallsAreIndependent() {
        let runningOpen = TurnActivity(work: .running, tools: .open)
        XCTAssertTrue(runningOpen.defaultExpanded(isLive: true))
        XCTAssertFalse(runningOpen.defaultExpanded(isLive: false))
        XCTAssertTrue(runningOpen.expandsToolRuns)

        let alwaysOpenFolded = TurnActivity(work: .open, tools: .folded)
        XCTAssertTrue(alwaysOpenFolded.defaultExpanded(isLive: false))
        XCTAssertFalse(alwaysOpenFolded.expandsToolRuns)
    }

    func testLegacyRemoteValueWinsOverAStaleLocalToolCache() {
        let merged = TurnActivity.mergingRemote(
            work: "expanded",
            tools: nil,
            local: TurnActivity(work: .running, tools: .folded)
        )

        XCTAssertEqual(merged, TurnActivity(work: .open, tools: .open))
    }
}
