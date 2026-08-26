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
/// intrinsically sized (a chip, a tag) rather than flexible. Rows are
/// top-aligned by default; mixed text styles can opt into first-baseline
/// alignment.
struct FlowLayout: Layout {
    let spacing: CGFloat
    var alignment: VerticalAlignment = .top

    private struct Measurement {
        let size: CGSize
        let guide: CGFloat
    }

    private struct Item {
        let index: Int
        let measurement: Measurement
    }

    private struct Row {
        var items: [Item] = []
        var width: CGFloat = 0
        var ascent: CGFloat = 0
        var descent: CGFloat = 0

        var height: CGFloat { ascent + descent }

        mutating func append(_ item: Item, spacing: CGFloat) {
            width += (items.isEmpty ? 0 : spacing) + item.measurement.size.width
            ascent = max(ascent, item.measurement.guide)
            descent = max(
                descent,
                item.measurement.size.height - item.measurement.guide
            )
            items.append(item)
        }
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = proposal.width ?? 0
        let rows = rows(for: subviews, limit: width)
        var height: CGFloat = 0
        for (index, row) in rows.enumerated() {
            height += (index == 0 ? 0 : spacing) + row.height
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var y = bounds.minY
        for row in rows(for: subviews, limit: bounds.width) {
            var x = bounds.minX
            for item in row.items {
                let measurement = item.measurement
                subviews[item.index].place(
                    at: CGPoint(
                        x: x,
                        y: y + row.ascent - measurement.guide
                    ),
                    proposal: ProposedViewSize(measurement.size)
                )
                x += measurement.size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func rows(for subviews: Subviews, limit: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (index, view) in subviews.enumerated() {
            let measurement = measure(view, limit: limit)
            if !row.items.isEmpty,
               row.width + spacing + measurement.size.width > limit {
                rows.append(row)
                row = Row()
            }
            row.append(
                Item(index: index, measurement: measurement),
                spacing: spacing
            )
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }

    /// One subview's size, never wider than the room there is.
    ///
    /// Measuring with `.unspecified` is what a chip wants: it asks for the
    /// width its text needs and the row wraps around it. At an accessibility
    /// type size that ideal can exceed the container itself, and a subview
    /// placed at a width nothing can honour is simply drawn through the
    /// trailing edge. Re-measuring at the width that does exist lets the
    /// subview wrap or truncate inside the layout instead of outside it.
    private func measure(_ view: LayoutSubviews.Element, limit: CGFloat) -> Measurement {
        let ideal = view.sizeThatFits(.unspecified)
        let proposal = if limit > 0, ideal.width > limit {
            ProposedViewSize(width: limit, height: nil)
        } else {
            ProposedViewSize(ideal)
        }
        let dimensions = view.dimensions(in: proposal)
        return Measurement(
            size: CGSize(width: dimensions.width, height: dimensions.height),
            guide: dimensions[alignment]
        )
    }
}
