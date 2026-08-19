import AVKit
import SwiftUI

/// Transcript recordings, streamed from the same range-enabled media route as
/// the web player. Each player keeps its own aspect ratio and, when the source
/// belongs to this session's scratch folder, opens the file as an asset.
struct ConversationVideoStrip: View {
    let sources: [String]
    let sessionId: String
    var maxWidth: CGFloat = 520
    var cornerRadius: CGFloat = 12
    var alignment: HorizontalAlignment = .leading

    private struct Source: Identifiable {
        let id: String
        let value: String
    }

    private var identifiedSources: [Source] {
        sources.enumerated().map { offset, source in
            Source(id: "\(offset):\(source)", value: source)
        }
    }

    var body: some View {
        if !sources.isEmpty {
            VStack(alignment: alignment, spacing: 6) {
                ForEach(identifiedSources) { source in
                    ConversationVideo(
                        source: source.value,
                        sessionId: sessionId,
                        cornerRadius: cornerRadius
                    )
                }
            }
            .frame(maxWidth: maxWidth)
            .frame(
                maxWidth: .infinity,
                alignment: Alignment(horizontal: alignment, vertical: .center)
            )
        }
    }
}

private struct ConversationVideo: View {
    let source: String
    let sessionId: String
    let cornerRadius: CGFloat

    @State private var player: AVPlayer?
    @State private var ratio: CGFloat?
    @State private var assetOverlay: AssetOverlayItem?
    @Environment(\.openPanel) private var openPanel

    private var url: URL? {
        OS1API.conversationMediaURL(
            source: source,
            base: ServerConfig.shared.baseURL
        )
    }

    private var assetPath: String? {
        AssetLinks.path(forMediaSource: source, sessionId: sessionId)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VideoPlayer(player: player)
                .aspectRatio(ratio ?? 16 / 9, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 520)

            if let assetPath, AssetOpen.canOpen(assetPath) {
                Button {
                    AssetOpen.open(
                        sessionId: sessionId,
                        path: assetPath,
                        overlay: $assetOverlay
                    )
                } label: {
                    Image(systemName: "arrow.up.right")
                        .font(.callout.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .foregroundStyle(.white)
                        .background(.black.opacity(0.55), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open video asset")
                .help("Open asset")
                .padding(6)
            }
        }
        .background(.black, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .stroke(.white.opacity(0.1), lineWidth: 0.5)
        }
        .task(id: source) {
            player = nil
            ratio = nil
            guard let url else { return }
            player = AVPlayer(url: url)
            let loadedRatio = await Self.displayRatio(of: url)
            guard !Task.isCancelled else { return }
            ratio = loadedRatio
        }
        .onDisappear { player?.pause() }
        .assetOverlayPreview($assetOverlay, openPanel: openPanel)
    }

    /// Width over height after applying the track's preferred transform. Phone
    /// recordings are commonly stored sideways and rotated for display.
    private static func displayRatio(of url: URL) async -> CGFloat? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let size = try? await track.load(.naturalSize),
              let transform = try? await track.load(.preferredTransform)
        else { return nil }
        let shown = size.applying(transform)
        let width = abs(shown.width), height = abs(shown.height)
        guard width > 0, height > 0 else { return nil }
        return width / height
    }
}
