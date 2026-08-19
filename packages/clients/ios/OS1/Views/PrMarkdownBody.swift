import AVFoundation
import AVKit
import SwiftUI

/// Pull-request markdown with GitHub user attachments resolved through this
/// Open Session instance. Bare attachment URLs are videos on GitHub, so the
/// native review keeps them inline instead of sending the reader to Safari.
struct PrMarkdownBody: View {
    let text: String
    let repo: String?

    var body: some View {
        let blocks = PrMarkdownMedia.blocks(
            in: text,
            repo: repo,
            baseURL: ServerConfig.shared.baseURL
        )
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .markdown(let markdown):
                    if !markdown.isEmpty { MarkdownBody(markdown) }
                case .video(let url):
                    PrAttachmentVideo(url: url)
                        .id(url)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PrAttachmentVideo: View {
    let url: URL

    @State private var player: AVPlayer?
    @State private var ratio: CGFloat?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VideoPlayer(player: player)
                .aspectRatio(ratio ?? 16 / 9, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 420)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Link(destination: url) {
                Label("Open video", systemImage: "arrow.up.right")
                    .font(.caption)
            }
        }
        .task {
            guard ratio == nil else { return }
            ratio = await displayRatio
        }
        .onAppear {
            guard player == nil else { return }
            player = AVPlayer(url: url)
        }
        .onDisappear { player?.pause() }
    }

    private var displayRatio: CGFloat? {
        get async {
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
}
