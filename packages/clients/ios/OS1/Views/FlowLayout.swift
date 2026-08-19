import SwiftUI

/// A row of chips that wraps instead of scrolling.
///
/// The alternative — a horizontal `ScrollView` — is the wrong tool inside the
/// transcript: it competes with the vertical scroll for the same drag, and it
/// gives no sign that anything is hidden past the trailing edge, so whatever
/// didn't fit reads as absent. What wraps is always on screen and always
/// tappable.
///
/// Subviews are laid out at their ideal size, so anything placed here must be
/// intrinsically sized (a chip, a tag) rather than flexible.
struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = proposal.width ?? 0
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var height: CGFloat = 0
        for view in subviews {
            let size = measure(view, limit: width)
            if rowWidth > 0, rowWidth + spacing + size.width > width {
                height += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth == 0 ? 0 : spacing) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: height + rowHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var point = bounds.origin
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = measure(view, limit: bounds.width)
            if point.x > bounds.minX, point.x + size.width > bounds.maxX {
                point.x = bounds.minX
                point.y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: point, proposal: ProposedViewSize(size))
            point.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }

    /// One subview's size, never wider than the room there is.
    ///
    /// Measuring with `.unspecified` is what a chip wants: it asks for the
    /// width its text needs and the row wraps around it. At an accessibility
    /// type size that ideal can exceed the container itself, and a subview
    /// placed at a width nothing can honour is simply drawn through the
    /// trailing edge. Re-measuring at the width that does exist lets the
    /// subview wrap or truncate inside the layout instead of outside it.
    private func measure(_ view: LayoutSubviews.Element, limit: CGFloat) -> CGSize {
        let ideal = view.sizeThatFits(.unspecified)
        guard limit > 0, ideal.width > limit else { return ideal }
        return view.sizeThatFits(ProposedViewSize(width: limit, height: nil))
    }
}
