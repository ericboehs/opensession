#if os(iOS)
import SwiftUI

/// The session's own actions, as one floating glass capsule directly above
/// the composer: archive, the ⋯ menu, a new session, the next chat. The web
/// client's phone layout puts them in the same place, and for the same
/// reason. On a phone the navigation bar is the far corner of the screen,
/// while this sits under the thumb that is already on the composer.
///
/// It hides while you write. The keyboard leaves little room between the
/// field and the transcript, so the bar fades and folds back into the composer.
/// Dismissing the keyboard brings the same glass capsule back from that edge.
///
/// The glass is a background SIBLING of the row, not an ancestor of it. A
/// `Menu` whose label sits INSIDE a glass subtree makes the system treat that
/// glass as the menu's morph source, which takes the whole bar off screen for
/// as long as the menu is open. The composer learned this the hard way. See
/// `SessionInputBar.composer`.
struct SessionActionBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Hidden completely while the composer has focus.
    let hidden: Bool
    /// Archive this workspace. Absent where there is nothing to archive.
    var onArchive: (() -> Void)?
    var onNewSession: (() -> Void)?
    var onNextChat: (() -> Void)?
    /// The ⋯ menu, built by the session view that owns its state.
    var menu: AnyView?

    /// Matches the composer's round controls, so the two read as one system.
    private static let control: CGFloat = 44

    var body: some View {
        Group {
            if !hidden {
                HStack(spacing: 2) {
                    if let onArchive {
                        iconButton("archivebox", label: "Archive", action: onArchive)
                    }
                    if let menu {
                        menu
                            .font(.system(size: 19))
                            .frame(width: Self.control, height: Self.control)
                    }
                    if (onArchive != nil || menu != nil)
                        && (onNewSession != nil || onNextChat != nil) {
                        Rectangle()
                            .fill(OS1VisualStyle.border)
                            .frame(width: 1, height: 20)
                            .padding(.horizontal, 2)
                            .accessibilityHidden(true)
                    }
                    if let onNewSession {
                        iconButton("plus", label: "New session", action: onNewSession)
                    }
                    if let onNextChat {
                        iconButton("arrow.right", label: "Next chat", action: onNextChat)
                    }
                }
                .padding(.horizontal, 2)
                .fixedSize()
                .clipShape(Capsule())
                // Clear Liquid Glass keeps these secondary actions lighter
                // than the solid writing surface directly below.
                .background { Color.clear.glassEffect(.clear, in: Capsule()) }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)
                .transition(
                    .opacity.combined(
                        with: reduceMotion
                            ? .identity
                            : .scale(scale: 0.92, anchor: .bottom)
                    )
                )
            }
        }
        .animation(
            reduceMotion ? .linear(duration: 0.12) : .smooth(duration: 0.28),
            value: hidden
        )
    }

    private func iconButton(
        _ symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                // Weight from the font, never `.resizable()`, so this sits at
                // the same stroke as the composer's controls.
                .font(.system(size: 19))
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(width: Self.control, height: Self.control)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
#endif
