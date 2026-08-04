import CoreGraphics

/// The transcript's "is the reader at the latest message?" test, kept out of
/// the view so it can be checked against real numbers instead of by eye.
///
/// It got this treatment after being wrong in a way no reading caught: the
/// obvious spelling, `contentOffset.y + containerSize.height`, silently
/// measures a full inset-height short of the bottom, because `containerSize`
/// excludes the scroll view's content insets while the offset and content size
/// include them. On an iPhone that is 257pt against an 80pt tolerance, so the
/// answer was "not pinned" for a reader sitting on the newest message — and
/// the return pill sat parked over the last line for months.
enum TranscriptScroll {
    /// Geometry of the transcript scroll view, in the fields `ScrollGeometry`
    /// hands over.
    struct Geometry: Equatable {
        /// Bottom edge of the visible region, in content coordinates.
        var visibleMaxY: CGFloat
        var contentHeight: CGFloat
        var insetBottom: CGFloat
    }

    /// How far the visible bottom edge is from as far down as the view goes.
    /// Zero at a dragged-to-the-end bottom; positive above it.
    static func distanceFromBottom(_ geometry: Geometry) -> CGFloat {
        geometry.contentHeight + geometry.insetBottom - geometry.visibleMaxY
    }

    /// Whether new output should follow the reader down.
    ///
    /// `tolerance` has to clear the transcript's trailing padding: scrolling to
    /// the bottom aligns the LAST BLOCK's bottom edge with the visible bottom,
    /// which deliberately leaves the composer's scrim run-up below the fold —
    /// so even "as far down as this view ever scrolls itself" sits that far
    /// from the content's end.
    static func isNearBottom(_ geometry: Geometry, tolerance: CGFloat) -> Bool {
        distanceFromBottom(geometry) <= tolerance
    }
}
