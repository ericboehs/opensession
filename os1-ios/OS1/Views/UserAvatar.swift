import SwiftUI

/// Small circular avatar shown next to user bubbles, group-chat style.
/// Signed-in via GitHub → the account's GitHub avatar; otherwise a tinted
/// initial derived from the display name. Transcript entries carry no
/// per-message identity, so this is the device's signed-in person — the same
/// approximation the composer uses when attributing prompts.
struct UserAvatar: View {
    var size: CGFloat = 26

    private var login: String { ServerConfig.shared.githubLogin }
    private var name: String { ServerConfig.shared.userName }

    var body: some View {
        Group {
            if let url = avatarURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initialCircle
                    }
                }
            } else {
                initialCircle
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel(name.isEmpty ? "You" : name)
    }

    private var avatarURL: URL? {
        guard !login.isEmpty else { return nil }
        // GitHub serves any account's avatar at github.com/<login>.png; 3x the
        // point size keeps it crisp on retina displays.
        return URL(string: "https://github.com/\(login).png?size=\(Int(size * 3))")
    }

    private var initialCircle: some View {
        ZStack {
            Circle().fill(fallbackColor.gradient)
            Text(initial)
                .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    private var initial: String {
        let source = name.isEmpty ? login : name
        guard let first = source.trimmingCharacters(in: .whitespaces).first else {
            return "?"
        }
        return String(first).uppercased()
    }

    /// Stable per-name hue so the fallback doesn't shift between launches
    /// (Swift's hashValue is seeded per-process).
    private var fallbackColor: Color {
        let source = name.isEmpty ? login : name
        var hash: UInt32 = 2166136261
        for byte in source.utf8 {
            hash = (hash ^ UInt32(byte)) &* 16777619
        }
        let hue = Double(hash % 360) / 360
        return Color(hue: hue, saturation: 0.45, brightness: 0.75)
    }
}
