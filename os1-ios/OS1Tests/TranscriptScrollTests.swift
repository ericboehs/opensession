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
            lineStats: ToolLineStats(),
            hasMedia: false
        )
    }

    func testAFoldYouOpenedStaysOpenAcrossRebuilds() {
        let store = FoldStateStore()
        let state = store.fold(for: turn("t1"), preference: "collapsed")
        state.toggle()
        XCTAssertTrue(state.expanded)
        // The display pass rebuilds blocks constantly (every 1s append).
        XCTAssertTrue(store.fold(for: turn("t1"), preference: "collapsed").expanded)
    }

    func testASettledFoldNeverReopensItself() {
        // A turn above the reader changing height on its own is how a
        // transcript loses your place, so only the live tail re-derives.
        let store = FoldStateStore()
        let settled = store.fold(for: turn("t1"), preference: "collapsed")
        XCTAssertFalse(settled.expanded)
        _ = store.fold(for: turn("t1"), preference: "expanded")
        XCTAssertFalse(settled.expanded)
    }

    func testTheLiveTurnFollowsThePreferenceUntilYouTouchIt() {
        let store = FoldStateStore()
        let live = store.fold(for: turn("t1", live: true), preference: "collapsed")
        XCTAssertFalse(live.expanded)
        _ = store.fold(for: turn("t1", live: true), preference: "expanded")
        XCTAssertTrue(live.expanded, "a live fold may still adopt a new default")

        live.toggle()
        XCTAssertFalse(live.expanded)
        _ = store.fold(for: turn("t1", live: true), preference: "expanded")
        XCTAssertFalse(live.expanded, "once you decide, the default stops winning")
    }

    func testFailuresAndMediaOnlyPullShortTurnsOpen() {
        var short = turn("t1", tools: 4)
        short.failureCount = 1
        XCTAssertTrue(short.defaultExpanded(preference: "collapsed"))

        var long = turn("t2", tools: 40)
        long.failureCount = 1
        XCTAssertFalse(
            long.defaultExpanded(preference: "collapsed"),
            "a 40-step fold is a wall on a phone; its header carries the signal"
        )
    }
}
