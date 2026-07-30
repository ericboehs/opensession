import SwiftUI
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum OS1VisualStyle {
    // Use native semantic surfaces so the app follows its Settings appearance.
    #if os(iOS)
    static let background = Color(uiColor: .systemBackground)
    static let raised = Color(uiColor: .secondarySystemBackground)
    static let panel = Color(uiColor: .tertiarySystemBackground)
    static let hover = Color(uiColor: .quaternarySystemFill)
    static let border = Color(uiColor: .separator)
    static let text = Color(uiColor: .label)
    static let textDim = Color(uiColor: .secondaryLabel)
    static let textFaint = Color(uiColor: .tertiaryLabel)
    static let userMessage = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.149, green: 0.192, blue: 0.259, alpha: 1)
            : UIColor(red: 0.933, green: 0.949, blue: 0.969, alpha: 1)
    })
    #else
    static let background = Color(nsColor: .windowBackgroundColor)
    static let raised = Color(nsColor: .underPageBackgroundColor)
    static let panel = Color(nsColor: .controlBackgroundColor)
    static let hover = Color(nsColor: .unemphasizedSelectedContentBackgroundColor)
    static let border = Color(nsColor: .separatorColor)
    static let text = Color(nsColor: .labelColor)
    static let textDim = Color(nsColor: .secondaryLabelColor)
    static let textFaint = Color(nsColor: .tertiaryLabelColor)
    /// Same blue-gray tint as the iOS user bubble, resolved per appearance,
    /// so the two apps read as one product.
    static let userMessage = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.149, green: 0.192, blue: 0.259, alpha: 1)
            : NSColor(red: 0.933, green: 0.949, blue: 0.969, alpha: 1)
    })
    #endif
    static let accent = Color(red: 1.0, green: 0.231, blue: 0.231)
    // One status palette on both platforms — the Mac previously used stock
    // Color.green/.yellow/… which rendered different hues than iOS.
    static let green = Color(red: 0.247, green: 0.725, blue: 0.314)
    static let yellow = Color(red: 0.824, green: 0.600, blue: 0.133)
    static let blue = Color(red: 0.345, green: 0.651, blue: 1.0)
    static let red = Color(red: 0.973, green: 0.318, blue: 0.286)
    static let purple = Color(red: 0.639, green: 0.443, blue: 0.969)
    #if os(iOS)
    static let chatMaxWidth: CGFloat = 780
    #else
    /// Keep 13pt desktop body copy near the comfortable 65-75 character range.
    static let chatMaxWidth: CGFloat = 720
    #endif
}

/// Compact repository identity used in repo headers and the conversation title.
/// Its stable single-letter swatch mirrors the web fallback tile.
struct RepoTile: View {
    let name: String
    var size: CGFloat = 18
    var round = false
    var showsFallback = true

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
            // The fallback letter swatch only stands in while the real icon
            // loads: many icons (org avatars) carry transparent margins, so a
            // swatch kept underneath bleeds through as a colored border.
            if let iconURL,
               let image = RepoImageCache.shared.images[iconURL.absoluteString] {
                image
                    .resizable()
                    .scaledToFill()
            } else if showsFallback {
                Text(letter)
                    .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(color)
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
        .task(id: iconURL?.absoluteString) {
            if let iconURL {
                await RepoImageCache.shared.ensureLoaded(iconURL)
            }
        }
    }
}

/// Shared cache prevents scrolling a list from cancelling and restarting repo
/// image requests, which left recycled tiles on their colored fallback.
@MainActor
@Observable
final class RepoImageCache {
    static let shared = RepoImageCache()

    private(set) var images: [String: Image] = [:]
    private var inflight: Set<String> = []
    private var lastFailureAt: [String: Date] = [:]

    func ensureLoaded(_ url: URL) async {
        let key = url.absoluteString
        guard images[key] == nil, !inflight.contains(key) else { return }
        if let failed = lastFailureAt[key], Date().timeIntervalSince(failed) < 15 {
            return
        }
        inflight.insert(key)
        defer { inflight.remove(key) }

        var request = ServerConfig.shared.authorizedRequest(url)
        request.cachePolicy = .returnCacheDataElseLoad
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse,
               !(200..<300).contains(http.statusCode) {
                lastFailureAt[key] = Date()
                return
            }
            #if os(macOS)
            guard let decoded = NSImage(data: data) else {
                lastFailureAt[key] = Date()
                return
            }
            images[key] = Image(nsImage: decoded)
            #else
            guard let decoded = UIImage(data: data) else {
                lastFailureAt[key] = Date()
                return
            }
            images[key] = Image(uiImage: decoded)
            #endif
            lastFailureAt[key] = nil
        } catch {
            lastFailureAt[key] = Date()
        }
    }
}
