import SwiftUI
#if os(macOS)
import AppKit
#endif

enum OS1VisualStyle {
    // Web dark-theme tokens. The native app keeps SwiftUI controls and glass,
    // but grounds them in the same warm charcoal hierarchy as os.tella.dev.
    #if os(iOS)
    static let background = Color(red: 0.114, green: 0.106, blue: 0.098)
    static let raised = Color(red: 0.141, green: 0.129, blue: 0.122)
    static let panel = Color(red: 0.161, green: 0.149, blue: 0.141)
    static let hover = Color(red: 0.196, green: 0.180, blue: 0.169)
    static let border = Color(red: 0.220, green: 0.200, blue: 0.184)
    static let text = Color(red: 0.933, green: 0.914, blue: 0.890)
    static let textDim = Color(red: 0.667, green: 0.635, blue: 0.604)
    static let textFaint = Color(red: 0.490, green: 0.459, blue: 0.431)
    #else
    static let background = Color(nsColor: .windowBackgroundColor)
    static let raised = Color(nsColor: .underPageBackgroundColor)
    static let panel = Color(nsColor: .controlBackgroundColor)
    static let hover = Color(nsColor: .unemphasizedSelectedContentBackgroundColor)
    static let border = Color(nsColor: .separatorColor)
    static let text = Color(nsColor: .labelColor)
    static let textDim = Color(nsColor: .secondaryLabelColor)
    static let textFaint = Color(nsColor: .tertiaryLabelColor)
    #endif
    static let accent = Color(red: 1.0, green: 0.231, blue: 0.231)
    #if os(iOS)
    static let green = Color(red: 0.247, green: 0.725, blue: 0.314)
    static let yellow = Color(red: 0.824, green: 0.600, blue: 0.133)
    static let blue = Color(red: 0.345, green: 0.651, blue: 1.0)
    static let red = Color(red: 0.973, green: 0.318, blue: 0.286)
    static let purple = Color(red: 0.639, green: 0.443, blue: 0.969)
    #else
    static let green = Color.green
    static let yellow = Color.yellow
    static let blue = Color.blue
    static let red = Color.red
    static let purple = Color.purple
    #endif
    static let chatMaxWidth: CGFloat = 780
}

/// Compact repository identity used in repo headers and the conversation title.
/// Its stable single-letter swatch mirrors the web fallback tile.
struct RepoTile: View {
    let name: String
    var size: CGFloat = 18
    var round = false

    static func label(for name: String) -> String {
        name == "backstage" ? "opensession" : name
    }

    private var letter: String {
        if name == "backstage" { return "O" }
        return String(name.prefix(1)).uppercased()
    }

    private var color: Color {
        let palette: [Color] = [
            Color(red: 0.91, green: 0.51, blue: 0.42),
            Color(red: 0.42, green: 0.65, blue: 0.91),
            Color(red: 0.56, green: 0.85, blue: 0.61),
            Color(red: 0.91, green: 0.77, blue: 0.42),
            Color(red: 0.75, green: 0.42, blue: 0.91),
            Color(red: 0.42, green: 0.91, blue: 0.82),
            Color(red: 0.91, green: 0.42, blue: 0.61),
            Color(red: 0.64, green: 0.72, blue: 0.42),
        ]
        let hash = name.lowercased().unicodeScalars.reduce(Int32(0)) {
            $0 &* 31 &+ Int32($1.value)
        }
        return palette[Int(hash.magnitude) % palette.count]
    }

    private var iconURL: URL? {
        ServerConfig.shared.baseURL?
            .appendingPathComponent("repo-icon")
            .appendingPathComponent("\(name).png")
    }

    var body: some View {
        ZStack {
            Text(letter)
                .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(color)
            if let iconURL {
                AsyncImage(url: iconURL) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(
            RoundedRectangle(
                cornerRadius: round ? size / 2 : size * 0.28,
                style: .continuous
            )
        )
            .accessibilityLabel(Self.label(for: name))
    }
}
