import SwiftUI

/// Who else has this session open right now, as a Figma/Notion-style stack of
/// faces — the native half of the web viewer's header facepile, fed by the
/// server's `presence` frames.
///
/// Only OTHER people appear. The web pile includes you (rightmost) because a
/// desktop header has room to spare; a phone navigation bar does not, and your
/// own face there tells you nothing you didn't know.
struct PresenceFacepile: View {
    /// How overlapping faces are told apart.
    enum Separation {
        /// A full ring in the chrome's own colour. Only correct where the
        /// backdrop is known and still — a navigation bar.
        case ring
        /// A seam that paints ONLY over the face beneath, never around the
        /// pile. What a list row needs, where the backdrop moves under it.
        case seam
    }

    let viewers: [String]
    var size: CGFloat = 26
    /// Overlapped pile vs faces side by side.
    var stacked: Bool = true
    /// How the overlap is separated. Ignored when `stacked` is false.
    ///
    /// A sidebar row's backdrop moves under it — plate, swipe, selection — so
    /// a full ring in any one colour reads as a hard frame on most of them.
    /// The web solved that (`SIDEBAR_WS_FACE`, lib/sidebar-classes) by ringing
    /// only the face ON TOP and offsetting it left, so the ring paints over
    /// the face beneath rather than around the pile: it needs no relationship
    /// to the backdrop at all. `.seam` is that.
    var separation: Separation = .ring

    /// Beyond this limit the pile stops being readable and the rest collapse
    /// into a count. Navigation bars keep the three-face default; the wider
    /// Feed row raises it to four to match the desktop sidebar.
    var maxFaces = 3

    /// A third of a face, the web's `-ml-1.5` against its 24px faces — enough
    /// overlap to read as a pile, short of hiding a face behind its neighbour.
    private var overlap: CGFloat { stacked ? size / 3 : -2 }

    /// A one-point cutout keeps overlapping photos distinct without making
    /// the separator heavier than the row it belongs to.
    private let seamWidth: CGFloat = 1

    var body: some View {
        if viewers.isEmpty {
            EmptyView()
        } else {
            HStack(spacing: -overlap) {
                ForEach(Array(shown.enumerated()), id: \.element) { index, viewer in
                    face(index: index) {
                        UserAvatar(person: viewer, size: size)
                    }
                }
                if overflow > 0 {
                    face(index: shown.count) {
                        Text(verbatim: "+\(overflow)")
                            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .frame(width: size, height: size)
                            .background(SquircleCapsule().fill(OS1VisualStyle.hover))
                    }
                }
            }
            // One label for the pile: VoiceOver reading three unlabelled
            // images as separate elements is noise, and the useful sentence is
            // who is here.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(label))
            #if os(macOS)
            .help(label)
            #endif
            .task(id: viewers) {
                await TeamDirectory.shared.ensureLoaded()
            }
        }
    }

    /// One face in the pile, separated from the one it overlaps.
    ///
    /// The ring is drawn as an overlay because it belongs to this face; the
    /// seam is drawn as a BACKGROUND offset left, so it is a copy of this
    /// face's own silhouette peeking out on the side that covers its
    /// neighbour — and nowhere else. A radial mask on the LOWER face was the
    /// web's first attempt and lost for a reason that holds here too: a
    /// circular hole bites a visible scoop out of the face beneath, while the
    /// seam follows the top face's own outline and leaves both whole.
    @ViewBuilder
    private func face(index: Int, @ViewBuilder content: () -> some View) -> some View {
        let separated = stacked && index > 0
        content()
            .background {
                if separated, separation == .seam {
                    SquircleCapsule()
                        // This is the row showing through, not a frame around
                        // the picture. Using its exact canvas avoids a grey
                        // halo on the white sidebar.
                        .fill(OS1VisualStyle.background)
                        .frame(width: size, height: size)
                        .offset(x: -seamWidth)
                }
            }
            .overlay {
                if stacked, separation == .ring {
                    // Stroked and clipped rather than `strokeBorder`, which is
                    // an `InsettableShape` method this hand-drawn superellipse
                    // does not have: a centred stroke at twice the width leaves
                    // exactly the inside half once the outside is clipped away.
                    SquircleCapsule()
                        .stroke(OS1VisualStyle.background, lineWidth: 3)
                        .clipShape(SquircleCapsule())
                }
            }
    }

    private var shown: [String] {
        Array(viewers.prefix(maxFaces))
    }

    private var overflow: Int {
        max(0, viewers.count - maxFaces)
    }

    private var label: String {
        let names = viewers.map { TeamDirectory.shared.fullName(for: $0) }
        return "Also viewing: " + ListFormatter.localizedString(byJoining: names)
    }
}
