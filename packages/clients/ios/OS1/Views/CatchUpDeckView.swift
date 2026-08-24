import SwiftUI

/// Which way a card is being sent.
enum CatchUpIntent: Equatable, Sendable {
    case archive, read, keep

    var action: CatchUpViewModel.Action {
        switch self {
        case .archive: .archive
        case .read: .read
        case .keep: .keep
        }
    }

    var label: String {
        switch self {
        case .archive: "Archive"
        case .read: "Read"
        case .keep: "Keep"
        }
    }

    var symbol: String {
        switch self {
        case .archive: "archivebox.fill"
        case .read: "checkmark"
        case .keep: "arrow.uturn.backward"
        }
    }

    var tint: Color {
        switch self {
        case .archive: OS1VisualStyle.red
        case .read: OS1VisualStyle.green
        case .keep: OS1VisualStyle.blue
        }
    }
}

/// Motion constants for the deck, in one place so the gesture, the buttons and
/// undo can't drift into three different feels.
enum CatchUpMotion {
    /// Each card behind the top one is this much smaller and this far up — a
    /// stack you can see the edge of, not a pile of identical rectangles.
    ///
    /// The two have to be read together: scaling a ~580pt card down by 4%
    /// already walks its top edge ~12pt DOWN, so an offset smaller than that
    /// hides the card behind instead of revealing it. The visible peek is the
    /// difference, and it is deliberately small — a stack, not a fan.
    static let depthScale = 0.04
    static let depthOffset: CGFloat = -28

    /// Room kept above the stack for that peek to live in.
    ///
    /// The peek goes UP, and it is the difference between `depthOffset` and
    /// the ~half-height the scale already walks a card down, about 15pt per
    /// level, so ~30pt for the two cards behind. Without this reserve the
    /// stack simply grows past the top of the deck and into the header, which
    /// is what covered the counter.
    static let peekReserve: CGFloat = 34

    /// How far the top card tips at a full swipe. A card pivots about a point
    /// well below itself, the way one does when you push it across a table.
    static let tiltDegrees = 13.0
    static let tiltAnchor = UnitPoint(x: 0.5, y: 1.25)

    /// Apple's momentum projection (Designing Fluid Interfaces): where a flick
    /// would come to rest, given its release velocity. Deciding on the
    /// PROJECTED point rather than the release point is what makes a short,
    /// fast flick throw the card instead of springing it back.
    static func project(_ velocity: CGFloat, decelerationRate: CGFloat = 0.998) -> CGFloat {
        (velocity / 1000) * decelerationRate / (1 - decelerationRate)
    }

    /// A spring that continues at the finger's own speed, so there is no seam
    /// between dragging and animating. `initialVelocity` is normalised by the
    /// distance still to travel, which is the unit SwiftUI wants.
    static func handoff(
        from current: CGSize,
        to target: CGSize,
        velocity: CGSize,
        duration: Double,
        bounce: Double
    ) -> Animation {
        let distance = hypot(target.width - current.width, target.height - current.height)
        let speed = hypot(velocity.width, velocity.height)
        let initial = distance > 1 ? min(Double(speed / distance), 30) : 0
        return .interpolatingSpring(
            duration: duration, bounce: bounce, initialVelocity: initial
        )
    }
}

private enum CatchUpDragAxis {
    case horizontal, vertical
}

/// The card stack: three slots, one gesture, and the two decisions that change
/// state — with the undo that makes them safe to make quickly.
struct CatchUpDeckView: View {
    let model: CatchUpViewModel
    let onOpen: (Session) -> Void
    let onReply: (String) -> Void
    let undoTrigger: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    /// Live drag translation of the top card. Everything else in the deck —
    /// the tilt, the stamps, how far forward the card behind has come — is a
    /// function of this one value, which is why the stack stays continuous
    /// when a swipe is reversed halfway.
    @State private var drag: CGSize = .zero
    /// Chosen once per touch so a diagonal reading gesture never changes into
    /// a card decision halfway through the drag.
    @State private var dragAxis: CatchUpDragAxis?
    /// Set while a card is on its way out; blocks a second gesture landing on
    /// a card that has already been decided.
    @State private var flinging: CatchUpIntent?
    /// The decision the current drag has passed the threshold for. Nil→value
    /// is where the one haptic tick belongs: the moment the throw would take.
    @State private var armed: CatchUpIntent?
    @State private var deckSize: CGSize = .zero

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                stack(in: geo.size)
                    .frame(width: geo.size.width, height: geo.size.height)
                    .onAppear { deckSize = geo.size }
                    .onChange(of: geo.size) { _, size in deckSize = size }
            }
            // Taken from the deck's own height rather than from the card's, so
            // the cards behind peek into space the stack owns instead of into
            // the header above it.
            .padding(.top, CatchUpMotion.peekReserve)
            actionBar
        }
        // Arming is a state change you can feel before you commit to it — one
        // tick crossing in, a softer one crossing back out.
        .haptic(trigger: armed) { _, now in
            now == nil ? .released : .armed
        }
        .onChange(of: undoTrigger) { _, _ in performUndo() }
    }

    // MARK: - Stack

    private func stack(in size: CGSize) -> some View {
        ZStack {
            ForEach(Array(slots.enumerated()), id: \.element.id) { depth, card in
                CatchUpCardView(
                    card: card,
                    conversation: model.conversations[card.id],
                    isTop: depth == 0,
                    onOpen: { onOpen(card.target) },
                    onReply: onReply
                )
                .frame(width: cardWidth(in: size), height: cardHeight(in: size))
                .overlay { if depth == 0 { stamps(in: size) } }
                .scaleEffect(scale(atDepth: depth, in: size))
                .offset(offset(atDepth: depth, in: size))
                .rotationEffect(
                    .degrees(depth == 0 ? tilt(in: size) : 0),
                    anchor: CatchUpMotion.tiltAnchor
                )
                .opacity(opacity(atDepth: depth, in: size))
                .zIndex(Double(slots.count - depth))
                .allowsHitTesting(depth == 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        // Vertical drags belong to the card's preview. Horizontal drags belong
        // to the deck; Keep remains the labeled center button below it.
        .simultaneousGesture(dragGesture(in: size))
    }

    /// Four slots are rendered, but the fourth is fully transparent: it is
    /// there so the card that becomes visible after a swipe fades IN during
    /// the swipe rather than appearing the instant the deck advances.
    private var slots: [CatchUpCard] {
        [model.current, model.next, model.following, model.card(atOffset: 3)]
            .compactMap { $0 }
    }

    // MARK: - Geometry

    private func cardWidth(in size: CGSize) -> CGFloat {
        max(240, min(size.width - 24, 520))
    }

    /// Capped, not just "the space available": a card that fills the pane is a
    /// page, and the peek of the stack behind it has nowhere to show. The cap
    /// leaves a margin top and bottom on a phone and stops the card growing
    /// into a slab on a tablet or a Mac window.
    private func cardHeight(in size: CGSize) -> CGFloat {
        max(300, min(size.height - 12, 760))
    }

    private func horizontalThreshold(in size: CGSize) -> CGFloat {
        max(88, cardWidth(in: size) * 0.28)
    }

    /// How far the current drag has taken the top card toward a decision,
    /// 0…1 — and, with it, how far forward every card behind it has come.
    private func progress(_ translation: CGSize, in size: CGSize) -> Double {
        min(1, Double(abs(translation.width) / horizontalThreshold(in: size)))
    }

    private func stackProgress(in size: CGSize) -> Double {
        reduceMotion ? 0 : progress(drag, in: size)
    }

    /// Depth as a continuous number: a card at slot 1 is at depth 1 when the
    /// deck is at rest and depth 0 when the card in front of it has been swiped
    /// all the way, so nothing jumps at the moment the deck advances.
    private func effectiveDepth(_ depth: Int, in size: CGSize) -> Double {
        max(0, Double(depth) - stackProgress(in: size))
    }

    private func scale(atDepth depth: Int, in size: CGSize) -> Double {
        1 - CatchUpMotion.depthScale * effectiveDepth(depth, in: size)
    }

    private func offset(atDepth depth: Int, in size: CGSize) -> CGSize {
        let behind = CGSize(
            width: 0,
            height: CatchUpMotion.depthOffset * effectiveDepth(depth, in: size)
        )
        guard depth == 0 else { return behind }
        return CGSize(width: drag.width, height: behind.height + drag.height)
    }

    private func opacity(atDepth depth: Int, in size: CGSize) -> Double {
        if depth == 0, reduceMotion, flinging != nil { return 0 }
        let effective = effectiveDepth(depth, in: size)
        if effective >= 3 { return 0 }
        return effective <= 1 ? 1 : 1 - (effective - 1) * 0.5
    }

    private func tilt(in size: CGSize) -> Double {
        guard !reduceMotion else { return 0 }
        let ratio = Double(drag.width / cardWidth(in: size))
        return max(-1.4, min(1.4, ratio)) * CatchUpMotion.tiltDegrees
    }

    // MARK: - Stamps

    /// The decision the current drag is heading for, drawn on the card the way
    /// a hand stamp would be: it grows and firms up as you commit, so the
    /// in-between frames say where this is going.
    @ViewBuilder
    private func stamps(in size: CGSize) -> some View {
        let intent = self.intent(for: drag)
        let amount = progress(drag, in: size)
        ZStack {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill((intent?.tint ?? .clear).opacity(0.10 * amount))
            if let intent {
                CatchUpStamp(intent: intent, amount: amount)
                    .frame(
                        maxWidth: .infinity,
                        maxHeight: .infinity,
                        alignment: stampAlignment(intent)
                    )
                    .padding(.horizontal, 22)
                    // Clear of the header. The classic place for a stamp like
                    // this is across the top corner, but the top corner of
                    // this card is the workspace's NAME — the one thing you
                    // are deciding about — and covering it mid-swipe hides
                    // what you are deciding.
                    .padding(.top, 92)
                    .padding(.bottom, 22)
            }
        }
        .allowsHitTesting(false)
    }

    private func stampAlignment(_ intent: CatchUpIntent) -> Alignment {
        switch intent {
        // The stamp sits on the edge the card is moving AWAY from, which is the
        // edge still on screen while it leaves.
        case .read: .topLeading
        case .archive: .topTrailing
        case .keep: .top
        }
    }

    // MARK: - Gesture

    private func dragGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard flinging == nil else { return }
                if dragAxis == nil {
                    dragAxis = abs(value.translation.width) > abs(value.translation.height)
                        ? .horizontal
                        : .vertical
                }
                // A vertical intent is scrolling the preview. Do not move or
                // arm the card while the nested ScrollView owns that gesture.
                guard dragAxis == .horizontal
                else {
                    if drag != .zero {
                        drag = .zero
                        armed = nil
                    }
                    return
                }
                drag = CGSize(width: value.translation.width, height: 0)
                let reached = progress(drag, in: size) >= 1
                let next = reached ? intent(for: drag) : nil
                if next != armed { armed = next }
            }
            .onEnded { value in
                guard flinging == nil else { return }
                defer { dragAxis = nil }
                guard dragAxis == .horizontal
                else {
                    drag = .zero
                    armed = nil
                    return
                }
                // Decide on where the flick is GOING, not where the finger let
                // go: a fast, short throw should commit.
                let projected = CGSize(
                    width: value.translation.width
                        + CatchUpMotion.project(value.velocity.width),
                    height: 0
                )
                if progress(projected, in: size) >= 1,
                   let committed = intent(for: projected) {
                    commit(committed, velocity: value.velocity, in: size)
                } else {
                    armed = nil
                    let spring = CatchUpMotion.handoff(
                        from: drag, to: .zero, velocity: value.velocity,
                        duration: 0.42, bounce: reduceMotion ? 0 : 0.24
                    )
                    withAnimation(spring) { drag = .zero }
                }
            }
    }

    private func intent(for translation: CGSize) -> CatchUpIntent? {
        if translation.width > 0 { return .read }
        if translation.width < 0 { return .archive }
        return nil
    }

    // MARK: - Commit

    /// Send the top card away and advance. The buttons call this too, with no
    /// velocity — one motion path, so a tap and a throw land the same way.
    private func commit(_ intent: CatchUpIntent, velocity: CGSize, in size: CGSize) {
        guard flinging == nil, model.current != nil else { return }
        let target = exitTranslation(for: intent, in: size)
        let spring = reduceMotion
            ? Animation.easeOut(duration: 0.2)
            : CatchUpMotion.handoff(
                from: drag, to: target, velocity: velocity,
                duration: 0.38, bounce: 0.06
            )
        armed = nil
        withAnimation(spring, completionCriteria: .logicallyComplete) {
            flinging = intent
            drag = target
        } completion: {
            // The card behind has already travelled to the front by now (the
            // whole stack is a function of `drag`, which is past the
            // threshold), so advancing the deck and zeroing the drag is a swap
            // of equal pictures — it must not animate, or it would undo that.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                model.act(intent.action)
                drag = .zero
                flinging = nil
            }
        }
    }

    /// Far enough to clear the screen along the direction of the decision —
    /// and, under reduced motion, nowhere at all: the card fades instead.
    private func exitTranslation(for intent: CatchUpIntent, in size: CGSize) -> CGSize {
        guard !reduceMotion else { return .zero }
        let distance = size.width + cardWidth(in: size)
        switch intent {
        case .read: return CGSize(width: distance, height: drag.height * 0.35 - 30)
        case .archive: return CGSize(width: -distance, height: drag.height * 0.35 - 30)
        case .keep: return CGSize(width: drag.width * 0.3, height: -(size.height + 200))
        }
    }

    /// Undo returns the card the way it left: placed back where it flew to,
    /// then sprung home. Reversing the path is what makes it read as the same
    /// card coming back rather than a new one arriving.
    private func performUndo() {
        guard let entry = model.undoable, flinging == nil else { return }
        let from = exitTranslation(
            for: CatchUpIntent(entry.action), in: deckSize
        )
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            model.undo()
            drag = from
        }
        withAnimation(.spring(response: 0.46, dampingFraction: 0.78)) { drag = .zero }
    }

    // MARK: - Controls

    private var actionBar: some View {
        HStack(spacing: 8) {
            decisionButton(.archive, label: "Archive", style: .archive)
            decisionButton(.keep, label: "Keep unread", style: .secondary)
            decisionButton(.read, label: "Mark as read", style: .primary)
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 10)
        // Above the cards for the same reason the header is: a tilted card
        // dips past its own bottom edge, and the three decisions must stay
        // legible while one is being made.
        .background(CatchUpBackdrop())
        .zIndex(1)
    }

    private enum DecisionStyle: Equatable {
        case archive, secondary, primary

        var foreground: Color {
            switch self {
            case .archive: OS1VisualStyle.red
            case .secondary: OS1VisualStyle.text
            case .primary: OS1VisualStyle.onAccent
            }
        }

        func fill(for colorScheme: ColorScheme) -> Color {
            switch self {
            case .archive, .secondary:
                colorScheme == .dark ? OS1VisualStyle.raised : OS1VisualStyle.background
            case .primary: OS1VisualStyle.accent
            }
        }
    }

    private func decisionButton(
        _ intent: CatchUpIntent,
        label: String,
        style: DecisionStyle
    ) -> some View {
        let live = self.intent(for: drag) == intent
        let amount = live ? progress(drag, in: deckSize) : 0
        return Button {
            commit(intent, velocity: .zero, in: deckSize)
        } label: {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .foregroundStyle(style.foreground)
                .frame(maxWidth: .infinity, minHeight: 54)
                .background {
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .fill(style.fill(for: colorScheme))
                        .overlay {
                            RoundedRectangle(cornerRadius: 17, style: .continuous)
                                .strokeBorder(
                                    OS1VisualStyle.border.opacity(
                                        colorScheme == .dark && style != .primary ? 0.7 : 0.2
                                    ),
                                    lineWidth: 0.5
                                )
                        }
                        .shadow(
                            color: .black.opacity(style == .primary ? 0.12 : 0.08),
                            radius: style == .primary ? 12 : 8,
                            y: style == .primary ? 7 : 4
                        )
                }
                .scaleEffect(1 + 0.025 * amount)
        }
        .buttonStyle(CatchUpPressStyle())
        .accessibilityLabel(accessibilityLabel(intent))
        .animation(.snappy(duration: 0.2), value: amount)
    }

    private func accessibilityLabel(_ intent: CatchUpIntent) -> String {
        switch intent {
        case .archive: "Archive this workspace"
        case .read: "Mark as read"
        case .keep: "Keep unread"
        }
    }
}

private struct CatchUpPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension CatchUpIntent {
    init(_ action: CatchUpViewModel.Action) {
        switch action {
        case .archive: self = .archive
        case .read: self = .read
        case .keep: self = .keep
        }
    }
}

/// The rotated badge that grows on the card as a swipe commits.
private struct CatchUpStamp: View {
    let intent: CatchUpIntent
    let amount: Double

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: intent.symbol)
                .font(.system(size: 15, weight: .bold))
            // Sentence case, like the web deck's own stamps: the product sets
            // no copy in caps.
            Text(intent.label)
                .font(.system(size: 15, weight: .heavy))
        }
        .foregroundStyle(intent.tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(intent.tint, lineWidth: 2.5)
        )
        .rotationEffect(.degrees(stampAngle))
        .scaleEffect(0.82 + 0.18 * amount)
        .opacity(min(1, amount * 1.35))
    }

    private var stampAngle: Double {
        switch intent {
        case .read: -13
        case .archive: 13
        case .keep: 0
        }
    }
}
