import SwiftUI

/// One card in the catch-up deck.
///
/// The workspace's main chat in a vertically scrolling card. Decisions swipe
/// horizontally, so reading never advances the deck by accident.
///
/// Only the top card draws its content. The ones behind are a title and a few
/// grey lines: nobody can read them, and rendering markdown three times over
/// for a stack that is about to move is exactly the kind of work that makes a
/// gesture stutter.
struct CatchUpCardView: View {
    let card: CatchUpCard
    let conversation: CatchUpViewModel.Conversation?
    let isTop: Bool
    let onOpen: () -> Void
    let onReply: (String) -> Void

    @State private var folds = FoldStateStore()
    @State private var reply = ""
    /// The card's own visible height, measured rather than assumed. It is the
    /// floor a short conversation fills so it starts at the top.
    @State private var viewportHeight: CGFloat = 0
    /// Set the moment the reader scrolls the card themselves, which ends the
    /// settling pass below: following the tail is a courtesy on arrival, not a
    /// claim on the scroll position afterwards.
    @State private var readerTookOver = false
    @Environment(\.colorScheme) private var colorScheme

    private let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow
            if isTop {
                Divider().overlay(OS1VisualStyle.border.opacity(0.6))
                bodyColumn
                footerRow
            } else {
                placeholderColumn
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(cardSurface)
        .clipShape(shape)
        .overlay(shape.strokeBorder(OS1VisualStyle.border.opacity(0.5), lineWidth: 0.5))
        // A card in hand casts more shadow than the ones under it, which is
        // most of what says which one you are holding.
        .shadow(
            color: .black.opacity(isTop ? 0.18 : 0.08),
            radius: isTop ? 26 : 12,
            y: isTop ? 14 : 6
        )
    }

    private var cardSurface: Color {
        colorScheme == .dark ? OS1VisualStyle.raised : OS1VisualStyle.background
    }

    private var composerSurface: Color {
        colorScheme == .dark ? OS1VisualStyle.panel : OS1VisualStyle.raised
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: 10) {
            RepoTile(name: card.repo, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                if isTop {
                    metaRow
                }
            }
            Spacer(minLength: 4)
            Button(action: onOpen) {
                Image(systemName: "arrow.up.forward")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open main chat")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
    }

    private var metaRow: some View {
        HStack(spacing: 6) {
            if card.isRunning {
                PulsingDot(color: OS1VisualStyle.yellowInk, size: 7)
                runningLabel
            } else {
                Circle()
                    .fill(laneColor)
                    .frame(width: 7, height: 7)
                Text(card.lane.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            Text("·").foregroundStyle(OS1VisualStyle.textFaint)
            Text(RepoTile.label(for: card.repo))
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .lineLimit(1)
        }
        .font(.caption)
    }

    /// Ticks only while the row is actually mid-run, and only on the top card —
    /// a second clock behind the one you are reading is pure battery.
    @ViewBuilder
    private var runningLabel: some View {
        if isTop, let since = card.runStartedAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                // Named, not a bare duration: unlabelled, it reads as "last
                // active" — the opposite of what it means.
                Text("Working \(elapsed(context.date.timeIntervalSince(since)))")
            }
            .font(.caption.weight(.medium).monospacedDigit())
            .foregroundStyle(OS1VisualStyle.yellowInk)
        } else {
            Text("Working")
                .font(.caption.weight(.medium))
                .foregroundStyle(OS1VisualStyle.yellowInk)
        }
    }

    private func elapsed(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        if total < 60 { return "\(total)s" }
        if total < 3_600 { return "\(total / 60)m" }
        return "\(total / 3_600)h \((total % 3_600) / 60)m"
    }

    private var laneColor: Color {
        switch card.lane {
        case .needsInput: OS1VisualStyle.blue
        case .inProgress: OS1VisualStyle.yellow
        case .inReview: OS1VisualStyle.purple
        case .done: OS1VisualStyle.green
        case .backlog: OS1VisualStyle.textFaint
        }
    }

    // MARK: - Body

    /// The normal transcript inside the card, opened on its LAST message.
    ///
    /// What is unread is the end of the conversation, so a card that lands at
    /// the beginning asks you to scroll before you can decide anything, and
    /// the whole point of the deck is deciding without opening.
    ///
    /// The second anchor is what keeps it there. One scroll to the bottom when
    /// the blocks arrive is not enough: markdown, images and lazily realised
    /// rows all resolve after that first layout, and each one grows the
    /// transcript under a scroll position that was correct when it was set,
    /// leaving the last message below the fold.
    private var bodyColumn: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                bodyContent
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .scrollIndicators(.visible)
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            // One viewport, for the content floor above. `containerSize` is the
            // unobstructed visible region, which is exactly the height a short
            // conversation should fill.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.containerSize.height
            } action: { _, height in
                viewportHeight = height
            }
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { readerTookOver = true }
            }
            // The anchors decide where the first layout lands; this is what
            // keeps it there while the rows SETTLE. Markdown, images and lazy
            // realisation all resolve over the next few frames, and a row that
            // measured short when the anchor was applied leaves the end of the
            // conversation below the fold, which is the whole complaint.
            // Aimed at the last real row rather than the 1pt sentinel, for the
            // blank-card reason above, so its own tail padding is what keeps
            // it off the composer.
            .task(id: conversation?.blocks.last?.id) {
                guard let last = conversation?.blocks.last?.id else { return }
                for _ in 0..<4 {
                    guard !readerTookOver else { return }
                    proxy.scrollTo(last, anchor: .bottom)
                    try? await Task.sleep(for: .milliseconds(200))
                    if Task.isCancelled { return }
                }
            }
        }
    }

    private var bodyContent: some View {
        LazyVStack(alignment: .leading, spacing: 10) {
            if let conversation {
                if conversation.failed {
                    caption("Couldn't load this conversation.")
                } else if conversation.blocks.isEmpty {
                    caption("Nothing in this conversation yet.")
                } else {
                    ForEach(conversation.blocks) { block in
                        TranscriptRow(
                            block: block,
                            sessionId: card.target.id,
                            worktreeDir: card.target.worktreeDir,
                            foldState: {
                                folds.fold(
                                    for: $0,
                                    preference: TurnActivity(work: .folded, tools: .folded)
                                )
                            },
                            expansionState: {
                                folds.expansion(id: $0, defaultExpanded: $1)
                            },
                            owner: card.target.isAutomation ? nil : card.target.startedBy
                        )
                        .id(block.id)
                        // The last row carries its own clearance: the stack's
                        // trailing padding does not travel with a scroll that
                        // aims at a row, so without it the newest message
                        // lands flush against the composer.
                        .padding(.bottom, block.id == conversation.blocks.last?.id ? 12 : 0)
                    }
                }
            } else {
                CatchUpConversationPlaceholder()
            }
            // A 1pt child at the very end, for the reason SessionView keeps
            // its `transcript-end`: a LazyVStack only realizes the children
            // that intersect the visible window, and a conversation that
            // groups into one long turn is a SINGLE child. Landing on the
            // bottom anchor leaves it unrealized and the card comes up blank
            // (measured: the whole body empty, 0.1% ink). Something small down
            // here always intersects, which keeps its neighbour realized.
            Color.clear.frame(height: 1)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        // A floor of one card, filled from the top. A scroll anchor also
        // decides where content SHORTER than the viewport sits, so without
        // this a two-line conversation hangs off the composer with the rest of
        // the card empty above it.
        .frame(maxWidth: .infinity, minHeight: viewportHeight, alignment: .topLeading)
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(OS1VisualStyle.textFaint)
    }

    // MARK: - Footer

    private var footerRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(width: 36, height: 36)
                .background(Circle().fill(OS1VisualStyle.hover))
            TextField("Message main chat", text: $reply, axis: .vertical)
                .lineLimit(1...4)
                .font(.body)
                .submitLabel(.send)
                .onSubmit(sendReply)
            Button(action: sendReply) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(
                        canReply ? OS1VisualStyle.accent : OS1VisualStyle.textFaint
                    )
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .disabled(!canReply)
            .accessibilityLabel("Send reply")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(composerSurface)
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .strokeBorder(OS1VisualStyle.border.opacity(0.4), lineWidth: 0.5)
                }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var canReply: Bool {
        !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendReply() {
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Haptics.play(.send)
        onReply(text)
        reply = ""
    }

    // MARK: - Behind the top card

    private var placeholderColumn: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach([0.72, 0.94, 0.55], id: \.self) { fraction in
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(OS1VisualStyle.hover)
                    .frame(height: 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .scaleEffect(x: fraction, anchor: .leading)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.top, 4)
    }
}

/// What a card shows while its conversation is still loading. Deliberately the
/// same shapes the loaded card uses, so nothing shifts when the text lands.
private struct CatchUpConversationPlaceholder: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach([0.35, 0.9, 0.78, 0.5], id: \.self) { fraction in
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(OS1VisualStyle.hover)
                    .frame(height: 11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .scaleEffect(x: fraction, anchor: .leading)
            }
        }
        .opacity(reduceMotion ? 0.8 : 1)
        .modifier(CatchUpBreathing(active: !reduceMotion))
        .accessibilityLabel("Loading")
    }
}

/// A slow, low-contrast pulse — enough to say "still loading", far enough from
/// a flashing element to leave alone under reduced motion.
private struct CatchUpBreathing: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.phaseAnimator([1.0, 0.45]) { view, opacity in
                view.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.85)
            }
        } else {
            content
        }
    }
}
