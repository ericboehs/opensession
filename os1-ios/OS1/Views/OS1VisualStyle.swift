import SwiftUI

enum OS1VisualStyle {
    /// Matches the web client's red accent while still flowing through native
    /// controls, selection, focus, and Liquid Glass materials.
    static let accent = Color(red: 0.96, green: 0.23, blue: 0.23)
    static let chatMaxWidth: CGFloat = 780
}

/// Compact repository identity used in repo headers and the conversation title.
/// Its stable single-letter swatch mirrors the web fallback tile.
struct RepoTile: View {
    let name: String
    var size: CGFloat = 18

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

    var body: some View {
        Text(letter)
            .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                color,
                in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            )
            .accessibilityLabel(Self.label(for: name))
    }
}
