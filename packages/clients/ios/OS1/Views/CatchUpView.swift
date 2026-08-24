import SwiftUI

/// Catch up — swipe through everything unread, one workspace at a time.
///
/// The screen is deliberately a DECK rather than a list: a list asks you to
/// choose what to look at next, and the whole point of catching up is that you
/// don't want to choose, you want to be handed the next thing. Three decisions
/// leave the deck — archive, mark read, keep unread — and each is available
/// both as a throw and as a button, sharing one motion path so the gesture and
/// the control never look like two different features.
///
/// Each card renders the workspace's main transcript. Vertical drags read it;
/// horizontal drags decide what happens to the workspace.
struct CatchUpView: View {
    let list: SessionsListViewModel
    /// Leave the deck for the real conversation. The CALLER closes this screen
    /// and pushes the session — the deck must not dismiss itself first, or the
    /// push races the cover's own dismissal and lands nowhere.
    let onOpenSession: (Session) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = CatchUpViewModel()
    @State private var undoTrigger = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            content
        }
        .background(CatchUpBackdrop())
        .task { await model.settle(from: list) }
        // Not `.success` on every finish: the chime belongs to the moment the
        // last card leaves, and only when there was something to clear.
        .haptic(trigger: model.isDone) { was, now in
            now && !was && model.handled > 0 ? .commit : nil
        }
    }

    // MARK: - Chrome

    private var header: some View {
        // The count is this screen's title, and the chevron is what the eye
        // lines it up against. It rides ON the control row as an overlay
        // rather than sitting beside it in a bottom-aligned stack, where it
        // was pinned to the row's lower edge and read 13pt low against a
        // chevron centred in its own 44pt tap box. As an overlay it takes that
        // same box's centre, and "Undo" appearing on the right cannot push it
        // off centre the way a third item in a row would.
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close catch up")
            Spacer()
            Button("Undo") { undoTrigger += 1 }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .frame(minWidth: 52, minHeight: 44, alignment: .trailing)
                .opacity(model.undoable == nil ? 0 : 1)
                .disabled(model.undoable == nil)
                .buttonStyle(.plain)
            repoFilterMenu
        }
        .overlay {
            Text(counterLabel)
                .font(.headline)
                .foregroundStyle(OS1VisualStyle.text)
                // The count is the one number on screen that changes as you
                // work, so it rolls rather than cutting.
                .contentTransition(.numericText(countsDown: true))
                .animation(.snappy(duration: 0.3), value: model.remaining)
                // Inert: a title laid over the row must not swallow a press
                // meant for a control beneath it.
                .allowsHitTesting(false)
        }
        // The row is 44pt (the buttons' tap target); the 45th is the progress
        // bar's own line, which stays on the header's bottom edge.
        .frame(height: 45)
        .overlay(alignment: .bottom) { progressBar }
        .padding(.horizontal, 8)
        // The deck passes UNDER the chrome. A card is not confined to its own
        // box: the stack peeks upward behind the top card, and a dragged card
        // tilts, which lifts its top corner well past that. Without a fill and
        // a raised z, the count and the back control are simply covered, and
        // they are the one part of the screen that has to stay readable while
        // you swipe.
        .background(CatchUpBackdrop())
        .zIndex(1)
    }

    /// Narrow the deck to one repo.
    ///
    /// Catching up is not one queue in practice: the work you can act on
    /// depends on which codebase you have in your head right now, and a deck
    /// that interleaves three of them makes you switch on every card. Offered
    /// only when there is genuinely more than one repo waiting, because a
    /// filter over a single repo is a control that cannot do anything.
    ///
    /// It filters the frozen queue rather than rebuilding it, so decisions
    /// already made stay made and nothing you have passed comes back.
    @ViewBuilder
    private var repoFilterMenu: some View {
        let options = model.repoOptions
        if options.count > 1 {
            Menu {
                Picker("Repo", selection: repoSelection) {
                    Text("All repos").tag(String?.none)
                    ForEach(options) { option in
                        // The count is what makes this a decision rather than a
                        // guess: it says how much is waiting behind each name.
                        Text("\(RepoTile.label(for: option.repo)) (\(option.remaining))")
                            .tag(String?.some(option.repo))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Image(
                    systemName: model.repoFilter == nil
                        ? "line.3.horizontal.decrease"
                        : "line.3.horizontal.decrease.circle.fill"
                )
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(
                    model.repoFilter == nil ? OS1VisualStyle.textDim : OS1VisualStyle.accent
                )
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .accessibilityLabel(
                model.repoFilter.map { "Showing \(RepoTile.label(for: $0)) only" }
                    ?? "Filter by repo"
            )
        }
    }

    private var repoSelection: Binding<String?> {
        Binding(get: { model.repoFilter }, set: { model.setRepoFilter($0) })
    }

    /// How far through the deck you are. A finish line is most of what makes a
    /// queue feel finishable.
    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(OS1VisualStyle.hover)
                Capsule()
                    .fill(OS1VisualStyle.accent)
                    .frame(width: max(0, geo.size.width * fractionDone))
            }
        }
        .frame(height: 2)
        .padding(.horizontal, 2)
        .animation(.snappy(duration: 0.38), value: fractionDone)
        .opacity(model.isEmpty ? 0 : 1)
        .accessibilityHidden(true)
    }

    /// Measured against the CURRENT scope, not the whole queue: filtered to one
    /// repo, a bar that counted the others would sit still while you cleared
    /// everything in front of you.
    private var fractionDone: Double {
        let total = model.scopeTotal
        guard total > 0 else { return 0 }
        return Double(total - model.remaining) / Double(total)
    }

    private var counterLabel: String {
        if model.isSettling && model.isEmpty { return "Catch up" }
        if model.isEmpty { return "All caught up" }
        if model.isDone {
            // Name the repo rather than claiming the queue: filtered, the only
            // thing that is finished is the thing you narrowed to.
            guard let repo = model.repoFilter else { return "All caught up" }
            return "\(RepoTile.label(for: repo)) clear"
        }
        return "\(model.remaining) left"
    }

    // MARK: - Body

    @ViewBuilder
    private var content: some View {
        if model.isSettling && model.isEmpty {
            // The shape the first card will take, not a spinner: nothing moves
            // when the real one arrives.
            CatchUpLoadingCard()
                .transition(.opacity)
        } else if model.isEmpty || model.isDone {
            CatchUpFinishedView(
                handled: model.handled,
                scopeRepo: model.repoFilter,
                remainingElsewhere: model.remainingElsewhere,
                onWiden: { model.setRepoFilter(nil) },
                onDone: { dismiss() }
            )
                .transition(
                    reduceMotion
                        ? .opacity
                        : .scale(scale: 0.94).combined(with: .opacity)
                )
        } else {
            CatchUpDeckView(
                model: model,
                onOpen: onOpenSession,
                onReply: model.reply,
                undoTrigger: undoTrigger
            )
        }
    }
}

/// The screen behind the deck: the app's own surface under a wash of accent.
/// A view rather than a colour because the chrome paints it too: a bar that
/// has to hide the cards passing under it must be the same fill as the page,
/// or it reads as a band laid over the screen.
struct CatchUpBackdrop: View {
    var body: some View {
        OS1VisualStyle.background
            .overlay(OS1VisualStyle.accent.opacity(0.06))
    }
}

// MARK: - Loading

/// What the deck shows while the sessions list and the read marks are still in
/// flight. Deliberately the card's own silhouette: the first real card lands in
/// the same place at the same size, so nothing jumps.
private struct CatchUpLoadingCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        RoundedRectangle(cornerRadius: 26, style: .continuous)
            .fill(OS1VisualStyle.background)
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(OS1VisualStyle.border.opacity(0.5), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.1), radius: 18, y: 10)
            .padding(.horizontal, 16)
            .padding(.bottom, 34)
            .opacity(breathing ? 0.55 : 1)
            .accessibilityLabel("Loading your unread work")
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                    breathing = true
                }
            }
    }
}

// MARK: - Finished

/// The end of the deck. Restrained on purpose — the reward for clearing a queue
/// is the empty queue, not a firework.
private struct CatchUpFinishedView: View {
    let handled: Int
    /// The repo the deck was narrowed to, if any: what was actually finished.
    let scopeRepo: String?
    /// Cards still waiting in the repos the filter is hiding.
    let remainingElsewhere: Int
    let onWiden: () -> Void
    let onDone: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var landed = false

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            ZStack {
                // One soft ring, expanding out of the seal as it lands: the
                // motion says "that's the last one" without an animation the
                // eye has to follow.
                Circle()
                    .stroke(OS1VisualStyle.accent.opacity(landed ? 0 : 0.35), lineWidth: 2)
                    .frame(width: 86, height: 86)
                    .scaleEffect(landed ? 1.55 : 0.7)
                Image(systemName: "checkmark")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.onAccent)
                    .frame(width: 86, height: 86)
                    .background(Circle().fill(OS1VisualStyle.accent))
                    .scaleEffect(landed ? 1 : 0.6)
                    .opacity(landed ? 1 : 0)
            }
            Text(title)
                .font(.title2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
            Text(subtitle)
                .font(.callout)
                .foregroundStyle(OS1VisualStyle.textDim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer()
            // The way back to the rest of the queue, offered where you are
            // standing. Otherwise finishing a filtered repo hands you a Done
            // button over work you never saw.
            if remainingElsewhere > 0 {
                Button("Show the other repos", action: onWiden)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.accent)
                    .buttonStyle(.plain)
                    .padding(.bottom, 4)
            }
            Button(action: onDone) {
                Text("Done")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(OS1VisualStyle.accent)
                    )
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .opacity(landed ? 1 : 0)
        .onAppear {
            guard !reduceMotion else {
                landed = true
                return
            }
            withAnimation(.spring(response: 0.5, dampingFraction: 0.62)) { landed = true }
        }
    }

    private var title: String {
        guard let scopeRepo else { return "All caught up" }
        return "\(RepoTile.label(for: scopeRepo)) is clear"
    }

    private var subtitle: String {
        if remainingElsewhere > 0 {
            let workspaces = remainingElsewhere == 1 ? "workspace" : "workspaces"
            return "\(remainingElsewhere) more \(workspaces) waiting in your other repos."
        }
        switch handled {
        case 0: return "Nothing unread right now."
        case 1: return "You went through one workspace."
        default: return "You went through \(handled) workspaces."
        }
    }
}
