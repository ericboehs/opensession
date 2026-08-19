import XCTest
@testable import OS1

/// The "am I at the latest message?" test, against numbers a real iPhone
/// reported. This is the arithmetic that decides whether new output follows
/// the reader down and whether the return pill is showing, and it was wrong
/// for months in a way that reading the code did not reveal — so the fixtures
/// here are measurements, not invented values.
final class TranscriptScrollTests: XCTestCase {
    /// iPhone 17 Pro, an OS1 session at rest at the bottom (logged from a
    /// running build): a 4454pt transcript, 874pt of visible height, 116/141pt
    /// content insets, resting 49pt above the content's end because
    /// `scrollToBottom` aligns the last BLOCK, leaving the trailing padding
    /// below the fold.
    private let atRest = TranscriptScroll.Geometry(
        visibleMaxY: 4546,
        contentHeight: 4454,
        insetBottom: 141
    )

    /// The tolerance the view uses on iOS: the composer's scrim run-up plus
    /// slack (OS1VisualStyle.composerScrimRunUp + 60).
    private let tolerance: CGFloat = 100

    func testTheRestingBottomCountsAsPinned() {
        XCTAssertEqual(TranscriptScroll.distanceFromBottom(atRest), 49)
        XCTAssertTrue(TranscriptScroll.isNearBottom(atRest, tolerance: tolerance))
    }

    func testTheOldContainerSizeSpellingWouldHaveMissedIt() {
        // What the predicate used to compute: contentOffset + containerSize,
        // where containerSize excludes both insets. Same scroll position,
        // 257pt of phantom distance — past any sane tolerance. Pinned here to
        // document the trap, since the two spellings look equivalent.
        let contentOffsetY: CGFloat = 3672
        let containerHeight: CGFloat = 617 // 874 visible − 116 − 141
        let asMeasuredBefore = atRest.contentHeight + atRest.insetBottom
            - (contentOffsetY + containerHeight)
        XCTAssertEqual(asMeasuredBefore, 306)
        XCTAssertFalse(asMeasuredBefore <= tolerance)
    }

    func testScrollingUpReleasesThePin() {
        var scrolledUp = atRest
        scrolledUp.visibleMaxY -= 400
        XCTAssertFalse(TranscriptScroll.isNearBottom(scrolledUp, tolerance: tolerance))
    }

    func testDraggingPastTheEndStaysPinned() {
        // Rubber-banding puts the visible edge beyond the content; a negative
        // distance is still "at the bottom", not a wrap-around.
        var overscrolled = atRest
        overscrolled.visibleMaxY += 120
        XCTAssertTrue(TranscriptScroll.isNearBottom(overscrolled, tolerance: tolerance))
    }

    func testAShortTranscriptIsAlwaysPinned() {
        // Content shorter than the viewport: nothing to scroll, so output must
        // keep following.
        let short = TranscriptScroll.Geometry(
            visibleMaxY: 874, contentHeight: 300, insetBottom: 141
        )
        XCTAssertTrue(TranscriptScroll.isNearBottom(short, tolerance: tolerance))
    }

    func testATranscriptFlooredToOneViewportIsPinned() {
        // A new session reads from the top because the content stack is never
        // shorter than the viewport — so a two-message transcript measures as
        // exactly one screenful and rests a full inset-height from the "end",
        // which the distance test alone calls scrolled away. It isn't: there
        // is nowhere to scroll, so the return pill must stay hidden and new
        // output must keep following.
        let floored = TranscriptScroll.Geometry(
            visibleMaxY: 758, contentHeight: 617, insetBottom: 141,
            containerHeight: 617
        )
        XCTAssertEqual(TranscriptScroll.distanceFromBottom(floored), 0)
        XCTAssertTrue(TranscriptScroll.isNearBottom(floored, tolerance: tolerance))
    }

    func testTheFloorNeverSwallowsARealScrollPosition() {
        // The short-circuit reads a HEIGHT, not a position: a long transcript
        // scrolled up is still scrolled up.
        var scrolledUp = atRest
        scrolledUp.containerHeight = 617
        scrolledUp.visibleMaxY -= 400
        XCTAssertFalse(TranscriptScroll.isNearBottom(scrolledUp, tolerance: tolerance))
    }
}

/// Keeping the reader's place when a page of earlier history is prepended.
/// The fixtures are the numbers a running iPhone 17 Pro logged while paging a
/// 5,901-entry session, back when the restore aimed at a block instead.
final class TranscriptPrependRestoreTests: XCTestCase {
    /// The navigation bar's inset, as the phone reports it.
    private let insetTop: CGFloat = 116

    func testAPageOfHistoryLeavesTheDistanceFromTheEndAlone() throws {
        // Measured: 11,495pt of transcript with the reader 29.8pt from its top,
        // and 12,603pt after the page landed. The rows arrived ABOVE the
        // reader, so their distance from the end is what has to survive.
        let before = TranscriptScroll.distanceFromEnd(offset: 29.8, contentHeight: 11_495)
        let y = try XCTUnwrap(TranscriptScroll.restoredScrollY(
            distanceFromEnd: before, contentHeight: 12_603, insetTop: insetTop
        ))
        // What the scroll view will report as its offset afterwards.
        XCTAssertEqual(
            TranscriptScroll.distanceFromEnd(offset: y - insetTop, contentHeight: 12_603),
            before,
            accuracy: 0.001
        )
    }

    func testTheTopInsetIsPartOfTheAnswer() throws {
        // Dropping it is not a rounding error: the restore lands a whole
        // navigation bar short, every tick, which reads as the transcript
        // creeping while it settles.
        let distance = TranscriptScroll.distanceFromEnd(offset: 21, contentHeight: 11_058)
        let withInset = try XCTUnwrap(TranscriptScroll.restoredScrollY(
            distanceFromEnd: distance, contentHeight: 12_404, insetTop: insetTop
        ))
        let without = try XCTUnwrap(TranscriptScroll.restoredScrollY(
            distanceFromEnd: distance, contentHeight: 12_404, insetTop: 0
        ))
        XCTAssertEqual(withInset - without, insetTop)
    }

    func testLeavingTheOffsetAloneIsTheJumpWeMeasured() {
        // What the app did before: the offset stayed put while the content
        // grew under it, which walked the reader back a page — 1,108pt here,
        // and the observed jumps ran to 2,186pt.
        let distanceBefore = TranscriptScroll.distanceFromEnd(
            offset: 29.8, contentHeight: 11_495
        )
        let distanceAfter = TranscriptScroll.distanceFromEnd(
            offset: 29.8, contentHeight: 12_603
        )
        XCTAssertEqual(distanceAfter - distanceBefore, 1108, accuracy: 0.001)
    }

    func testTheRestoreFollowsRowsThatKeepMeasuring() throws {
        // A page's height lands in steps — the rows realize and their markdown
        // parses afterwards — so the restore recomputes against the newest
        // height instead of setting one offset and trusting it.
        let distance = TranscriptScroll.distanceFromEnd(offset: 26.3, contentHeight: 11_129)
        let settling: [CGFloat] = [11_915, 11_926, 12_017, 12_064, 12_110, 12_156]
        for height in settling {
            let y = try XCTUnwrap(TranscriptScroll.restoredScrollY(
                distanceFromEnd: distance, contentHeight: height, insetTop: insetTop
            ))
            XCTAssertEqual(
                TranscriptScroll.distanceFromEnd(offset: y - insetTop, contentHeight: height),
                distance,
                accuracy: 0.001,
                "every step has to land the reader in the same place"
            )
        }
    }

    func testTheRestoreWaitsForALazyStackThatBrieflyShrinks() {
        // The live stack briefly reported 19,298pt after it had already been
        // 21,095pt before the prepend. Treating that as a real target sent the
        // reader to the top; the next measurement is the one that can restore.
        let distance = TranscriptScroll.distanceFromEnd(
            offset: -124, contentHeight: 21_095
        )
        XCTAssertNil(TranscriptScroll.restoredScrollY(
            distanceFromEnd: distance,
            contentHeight: 19_298,
            insetTop: insetTop,
            minimumContentHeight: 21_095
        ))
        XCTAssertNotNil(TranscriptScroll.restoredScrollY(
            distanceFromEnd: distance,
            contentHeight: 22_000,
            insetTop: insetTop,
            minimumContentHeight: 21_095
        ))
    }

    func testTheBaselineRejectsAPositiveButStaleLazyHeight() {
        // A reader far enough down can still get a positive target from a
        // shrunken lazy stack. The baseline, not y's sign alone, keeps that
        // stale target from visibly moving the reader upward.
        XCTAssertNil(TranscriptScroll.restoredScrollY(
            distanceFromEnd: 8_000,
            contentHeight: 10_500,
            insetTop: insetTop,
            minimumContentHeight: 12_000
        ))
    }
}

/// Fold state has to outlive its row: inside a `LazyVStack` a row's `@State`
/// dies when it scrolls out of the realization window, which is why this lives
/// on the view model. These pin the rules that make a fold feel stable.
@MainActor
final class FoldStateTests: XCTestCase {
    private func turn(_ id: String, live: Bool = false, tools: Int = 3) -> WorkTurn {
        WorkTurn(
            id: id,
            anchorId: id,
            items: [],
            isLive: live,
            duration: nil,
            families: [.run],
            toolCount: tools,
            failureCount: 0,
            touchedFiles: [],
            lineStats: ToolLineStats()
        )
    }

    func testAFoldYouOpenedStaysOpenAcrossRebuilds() {
        let store = FoldStateStore()
        let state = store.fold(for: turn("t1"), preference: TurnActivity(work: .folded))
        state.toggle()
        XCTAssertTrue(state.expanded)
        // The display pass rebuilds blocks constantly (every 1s append).
        XCTAssertTrue(store.fold(for: turn("t1"), preference: TurnActivity(work: .folded)).expanded)
    }

    func testASettledFoldNeverReopensItself() {
        // A turn above the reader changing height on its own is how a
        // transcript loses your place, so only the live tail re-derives.
        let store = FoldStateStore()
        let settled = store.fold(for: turn("t1"), preference: TurnActivity(work: .folded))
        XCTAssertFalse(settled.expanded)
        _ = store.fold(for: turn("t1"), preference: TurnActivity(work: .open))
        XCTAssertFalse(settled.expanded)
    }

    func testTheLiveTurnFollowsThePreferenceUntilYouTouchIt() {
        let store = FoldStateStore()
        let live = store.fold(for: turn("t1", live: true), preference: TurnActivity(work: .folded))
        XCTAssertFalse(live.expanded)
        _ = store.fold(for: turn("t1", live: true), preference: TurnActivity(work: .open))
        XCTAssertTrue(live.expanded, "a live fold may still adopt a new default")

        live.toggle()
        XCTAssertFalse(live.expanded)
        _ = store.fold(for: turn("t1", live: true), preference: TurnActivity(work: .open))
        XCTAssertFalse(live.expanded, "once you decide, the default stops winning")
    }

    func testNestedExpansionFollowsItsDefaultUntilYouTouchIt() {
        let store = FoldStateStore()
        let state = store.expansion(id: "run-t1", defaultExpanded: false)
        XCTAssertFalse(state.expanded)

        _ = store.expansion(id: "run-t1", defaultExpanded: true)
        XCTAssertTrue(state.expanded, "Always expanded should apply without remounting")

        state.toggle()
        XCTAssertFalse(state.expanded)
        _ = store.expansion(id: "run-t1", defaultExpanded: true)
        XCTAssertFalse(state.expanded, "a manual nested toggle still wins")
    }

    func testFoldDefaultFollowsOnlyThePreference() {
        var settled = turn("t1", tools: 4)
        settled.failureCount = 1
        settled.featuredMedia = TranscriptMedia(videos: ["/media?path=demo.mp4"])

        XCTAssertFalse(settled.defaultExpanded(preference: TurnActivity(work: .folded)))
        XCTAssertFalse(settled.defaultExpanded(preference: TurnActivity(work: .running)))
        XCTAssertTrue(settled.defaultExpanded(preference: TurnActivity(work: .open)))
        XCTAssertTrue(turn("t2", live: true).defaultExpanded(preference: TurnActivity(work: .running)))
    }
}
