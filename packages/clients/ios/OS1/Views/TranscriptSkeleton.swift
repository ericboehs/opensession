import SwiftUI

/// Ghost rows standing in for a transcript that has not arrived yet.
///
/// A spinner and the words "Loading conversation…" describe the wait; these
/// describe what is coming. Laid out in the transcript's own geometry — a
/// prompt bubble against the trailing edge, the answer's lines under it,
/// twice — so the real rows land into the shape already on screen instead of
/// replacing a centered notice.
///
/// Held back for a beat, like the web's: most transcripts arrive fast enough
/// that a placeholder would flash and go, which is more distracting than the
/// empty canvas it stands in for. Only a load slow enough to notice gets
/// stood in for at all.
struct TranscriptSkeleton: View {
    /// How long a load may take before it is worth drawing. Matches the web
    /// viewer's `ConversationLoading`.
    private static let appearDelay = Duration.milliseconds(180)

    /// One prompt-and-answer pair. Widths are fractions of the transcript
    /// column, so the ghosts keep their proportions on a phone and on a Mac
    /// window without a second set of numbers.
    private struct GhostTurn: Identifiable {
        let id: Int
        let bubbleWidth: CGFloat
        let bubbleHeight: CGFloat
        let lines: [CGFloat]
    }

    private static let turns: [GhostTurn] = [
        GhostTurn(id: 0, bubbleWidth: 0.42, bubbleHeight: 42, lines: [0.68, 0.84, 0.51]),
        GhostTurn(id: 1, bubbleWidth: 0.28, bubbleHeight: 32, lines: [0.76, 0.38]),
    ]

    @State private var visible = false
    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 18) {
                ForEach(Self.turns) { turn in
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(OS1VisualStyle.hover)
                        .frame(
                            width: geometry.size.width * turn.bubbleWidth,
                            height: turn.bubbleHeight
                        )
                        .frame(maxWidth: .infinity, alignment: .trailing)

                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(turn.lines.enumerated()), id: \.offset) { _, width in
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(OS1VisualStyle.hover)
                                .frame(width: geometry.size.width * width, height: 12)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // The breathing sits on the ghosts, the fade-in on the whole
            // stack, so the two opacities never fight over one value.
            .opacity(dimmed ? 0.5 : 1)
            .animation(
                reduceMotion
                    ? nil
                    : .easeInOut(duration: 1).repeatForever(autoreverses: true),
                value: dimmed
            )
        }
        .opacity(visible ? 1 : 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading conversation")
        .task {
            try? await Task.sleep(for: Self.appearDelay)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { visible = true }
            dimmed = true
        }
    }
}
