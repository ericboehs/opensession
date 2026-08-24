import SwiftUI

/// A pointer scrubber for the messages the current person sent in this session.
/// The ticks are decoration; the whole rail is one native control so tiny marks
/// never become tiny hit targets.
struct SentMessageRail: View {
    let messages: [SentMessageAnchor]
    let height: CGFloat
    let onJump: (SentMessageAnchor) -> Void

    @State private var activeID: String?
    @State private var hovering = false
    @FocusState private var focused: Bool

    private let horizontalPadding: CGFloat = 8
    private let verticalPadding: CGFloat = 10
    private let idealPitch: CGFloat = 10
    private let maximumTickWidth: CGFloat = 20
    private let tickHeight: CGFloat = 3

    private var isActive: Bool { hovering || focused }
    private var activeIndex: Int {
        activeID.flatMap { id in messages.firstIndex { $0.id == id } } ?? 0
    }
    private var pitch: CGFloat {
        guard messages.count > 1 else { return 0 }
        return min(idealPitch, max(0, (height - verticalPadding * 2) / CGFloat(messages.count - 1)))
    }

    var body: some View {
        #if os(macOS)
        rail.onMoveCommand { direction in
            switch direction {
            case .up: step(-1)
            case .down: step(1)
            default: break
            }
        }
        #else
        rail
        #endif
    }

    private var rail: some View {
        Button {
            jump()
        } label: {
            Canvas { context, _ in
                for index in messages.indices {
                    let distance = abs(index - activeIndex)
                    let lift = isActive ? max(0, 1 - CGFloat(distance) / 4) : 0
                    let width = 8 + (maximumTickWidth - 8) * lift
                    let opacity = isActive ? 0.25 + 0.75 * lift : 0.24
                    let rect = CGRect(
                        x: horizontalPadding,
                        y: tickY(index) - tickHeight / 2,
                        width: width,
                        height: tickHeight
                    )
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: tickHeight / 2),
                        with: .color(OS1VisualStyle.text.opacity(opacity))
                    )
                }
            }
            .frame(width: maximumTickWidth + horizontalPadding * 2, height: height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .onContinuousHover(coordinateSpace: .local) { phase in
            switch phase {
            case .active(let location):
                hovering = true
                select(index(at: location.y))
            case .ended:
                hovering = false
            }
        }
        .overlay(alignment: .topLeading) {
            if isActive, let message = activeMessage {
                SentMessagePreview(message: message)
                    .offset(x: maximumTickWidth + horizontalPadding * 2 + 8, y: previewY)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sent messages")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Choose a message, then activate to jump to it")
        .accessibilityAddTraits(.isButton)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
        .onAppear {
            if activeID == nil { activeID = messages.first?.id }
        }
        .onChange(of: messages.map(\.id)) {
            if let activeID, messages.contains(where: { $0.id == activeID }) { return }
            activeID = messages.first?.id
        }
    }

    private var activeMessage: SentMessageAnchor? {
        messages.indices.contains(activeIndex) ? messages[activeIndex] : nil
    }

    private var accessibilityValue: String {
        guard let message = activeMessage else { return "No messages" }
        return "Message \(activeIndex + 1) of \(messages.count): \(message.preview)"
    }

    private var previewY: CGFloat {
        min(max(0, tickY(activeIndex) - 38), max(0, height - 76))
    }

    private func tickY(_ index: Int) -> CGFloat {
        verticalPadding + CGFloat(index) * pitch
    }

    private func index(at y: CGFloat) -> Int {
        guard messages.count > 1 else { return 0 }
        let usableHeight = max(1, height - verticalPadding * 2)
        let progress = min(max(0, (y - verticalPadding) / usableHeight), 1)
        let raw = Int((progress * CGFloat(messages.count - 1)).rounded())
        return min(max(0, raw), messages.count - 1)
    }

    private func step(_ delta: Int) {
        guard !messages.isEmpty else { return }
        select(min(max(0, activeIndex + delta), messages.count - 1))
    }

    private func select(_ index: Int) {
        guard messages.indices.contains(index) else { return }
        activeID = messages[index].id
    }

    private func jump() {
        guard let message = activeMessage else { return }
        onJump(message)
    }
}

private struct SentMessagePreview: View {
    let message: SentMessageAnchor

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message.preview)
                .font(.callout.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(3)
            if let timestamp = message.timestamp {
                Text(timestamp.formatted(.relative(presentation: .named)))
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 6)
    }
}
