import HighlightSwift
import SwiftUI

private actor MarkdownCodeHighlighter {
    static let shared = MarkdownCodeHighlighter()

    private let highlighter = Highlight()

    func attributedText(for code: String, colorScheme: ColorScheme) async -> AttributedString? {
        let colors: HighlightColors = colorScheme == .dark ? .dark(.github) : .light(.github)
        return try? await highlighter.attributedText(code, colors: colors)
    }
}

struct MarkdownCodeFenceView: View {
    let fence: MarkdownCodeFence

    @Environment(\.colorScheme) private var colorScheme
    @State private var attributedText: AttributedString?
    @State private var isCopied = false
    @State private var feedbackTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if !fence.language.isEmpty {
                    Text(fence.language)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                Spacer(minLength: 8)
                Button(action: didTapCopy) {
                    Label(
                        isCopied ? "Copied" : "Copy code",
                        systemImage: isCopied ? "checkmark" : "document.on.document"
                    )
                    .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .foregroundStyle(OS1VisualStyle.textDim)
                .contentShape(Rectangle())
                .accessibilityLabel(isCopied ? "Copied" : "Copy code")
                .accessibilityHint("Copies only this code block")
                #if os(iOS)
                .frame(minHeight: 44)
                #else
                .frame(minHeight: 28)
                #endif
            }
            .font(.caption)
            .padding(.horizontal, 14)

            ScrollView(.horizontal) {
                Text(attributedText ?? AttributedString(fence.contents))
                    .font(codeFont)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
            }
            .scrollIndicators(.automatic)
        }
        .background(
            OS1VisualStyle.markdownCodeWell,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .task(id: HighlightRequest(code: fence.contents, colorScheme: colorScheme)) {
            attributedText = await MarkdownCodeHighlighter.shared.attributedText(
                for: fence.contents,
                colorScheme: colorScheme
            )
        }
        .onDisappear {
            feedbackTask?.cancel()
        }
    }

    private var codeFont: Font {
        #if os(iOS)
        .system(size: 15, design: .monospaced)
        #else
        .system(size: 12, design: .monospaced)
        #endif
    }

    private func didTapCopy() {
        fence.copy(to: SystemCodeFenceClipboard())
        isCopied = true
        feedbackTask?.cancel()
        feedbackTask = Task {
            try? await Task.sleep(for: .milliseconds(1600))
            guard !Task.isCancelled else { return }
            isCopied = false
        }
    }

    private struct HighlightRequest: Equatable {
        let code: String
        let colorScheme: ColorScheme
    }
}
