import SwiftUI

/// A row of capsule tabs in the session strip's idiom: the one you are on is
/// the solid, lighter pill and its siblings sit a step back, so the row reads
/// lit-one and dimmed-rest at a glance rather than by a shade of grey.
///
/// A sibling of `SessionTabBar` rather than a shared primitive. That strip is
/// a rail of open sessions: it scrolls, each pill carries an activity dot and
/// a close affordance, and it keeps the open one centred. This is the plain
/// version for a handful of fixed pages. Making one serve both would mean
/// options for everything the other does not have, and the two are already
/// close enough to read as one pattern.
struct PillTabBar<Value: Hashable>: View {
    struct Item: Identifiable {
        let value: Value
        let title: String
        var symbol: String?
        /// Shown after the title, for a page whose size is worth knowing
        /// before you go to it.
        var count: Int?

        var id: Value { value }
    }

    @Binding var selection: Value
    let items: [Item]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var activeIndicator

    /// Every pill wears this shape — its glass, its material and the active
    /// fill — so the three layers share one silhouette.
    private var shape: Capsule { Capsule(style: .continuous) }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(items) { item in
                pill(item)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    private func pill(_ item: Item) -> some View {
        let active = item.value == selection
        return Button {
            guard !active else { return }
            if reduceMotion {
                selection = item.value
            } else {
                withAnimation(.snappy) { selection = item.value }
            }
            Haptics.play(.selection)
        } label: {
            HStack(spacing: 6) {
                if let symbol = item.symbol {
                    Image(systemName: symbol)
                        .font(.caption2.weight(.semibold))
                }
                Text(item.title)
                    .font(.footnote.weight(active ? .semibold : .medium))
                if let count = item.count, count > 0 {
                    Text("\(count)")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
            }
            .foregroundStyle(active ? OS1VisualStyle.text : OS1VisualStyle.textFaint)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        // The session strip's own three layers, in its order. The active
        // fill sits INSIDE the pill's glass, above the material: with every
        // pill carrying its own surface there is no shared band for an
        // indicator to slide along, so "selected" is the pill's own surface,
        // opaque and lighter than the canvas rather than tinted.
        .background {
            if active {
                let indicator = shape.fill(OS1VisualStyle.tabActive)
                if reduceMotion {
                    indicator
                } else {
                    indicator.matchedGeometryEffect(id: "active-pill", in: activeIndicator)
                }
            }
        }
        // Near-solid, exactly like the strip in chat: page content passes
        // behind this row, and bare glass took on the luminance of whatever
        // scrolled under it. The page colour over a thick material holds each
        // pill at a stable brightness; idle pills keep less of that paint, so
        // the row reads lit-one and dimmed-rest.
        .background(
            OS1VisualStyle.background.opacity(active ? 0.7 : 0.3),
            in: shape
        )
        .background(.thickMaterial, in: shape)
        .glassSurface(in: shape, interactive: true)
        .accessibilityAddTraits(active ? [.isSelected, .isButton] : .isButton)
    }
}
