#if os(iOS)
import SwiftUI

/// Short-lived action feedback below the session tabs and navigation bar.
/// Hosted by `SessionView`'s top safe-area inset, so it never covers either.
struct SessionToastBanner: View {
    let viewModel: SessionViewModel

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var notice: String? {
        guard let notice = viewModel.notice else { return nil }
        if case .connected = viewModel.connectionState { return notice }
        let normalized = notice.lowercased()
        return normalized.contains("connect") || normalized.contains("socket")
            ? nil
            : notice
    }

    var body: some View {
        if let notice {
            let tone = NoticeTone.derived(fromText: notice)
            Button(action: viewModel.dismissNotice) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let symbol = tone.symbol {
                        Image(systemName: symbol)
                    }
                    Text(notice)
                        .lineLimit(2)
                }
                .font(.caption)
                .foregroundStyle(tone.color)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .frame(minHeight: 44)
                .glassSurface(
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous),
                    interactive: true
                )
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .frame(maxWidth: 380)
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .frame(maxWidth: .infinity)
            .transition(
                reduceMotion
                    ? .opacity
                    : .move(edge: .top).combined(with: .opacity)
            )
            .accessibilityHint("Dismisses the notice")
        }
    }
}
#endif
