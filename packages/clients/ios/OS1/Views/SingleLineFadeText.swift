import SwiftUI

/// Keeps a single-line label inside its frame and softly fades its trailing
/// edge only when the full text does not fit.
struct SingleLineFadeText: View {
    let text: String
    let font: Font
    let width: CGFloat

    @State private var textWidth: CGFloat = 0

    private let fadeWidth: CGFloat = 20

    private var isOverflowing: Bool {
        textWidth - width > 1
    }

    private var fadeStart: CGFloat {
        guard width > 0 else { return 1 }
        return max(0, 1 - fadeWidth / width)
    }

    var body: some View {
        Text(text)
            .font(font)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(width: width, alignment: .leading)
            .clipped()
            .mask {
                if isOverflowing {
                    LinearGradient(
                        stops: [
                            .init(color: .black, location: 0),
                            .init(color: .black, location: fadeStart),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                } else {
                    Rectangle()
                }
            }
            .background {
                Text(text)
                    .font(font)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .hidden()
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                        textWidth = $0
                    }
            }
    }
}
