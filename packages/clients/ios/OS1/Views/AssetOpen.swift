import SwiftUI

/// The scratch file a transcript chip is about to open over the conversation.
///
/// Identifiable so the viewer is presented with `fullScreenCover(item:)`: the
/// file it opens with is the one that was tapped, even if the turn's chips
/// change underneath it while it is up.
struct AssetOverlayItem: Identifiable, Equatable {
    let sessionId: String
    let path: String

    var id: String { "\(sessionId)#\(path)" }

    /// Last path component — what the file is called, without its folder.
    var name: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

/// What tapping a scratch file in the transcript does.
///
/// The transcript names an asset in two places — the tool row that wrote it
/// and the chip in that turn's footer — and both come through here, so the two
/// ways into one file can't drift apart.
/// Every file opens over the conversation. Pictures keep the zoomable viewer
/// every other transcript image uses; documents get their existing renderer in
/// a full-screen cover. Both can be promoted into the Assets view from there.
enum AssetOpen {
    /// Extensions the picture viewer can render. SVG is deliberately absent:
    /// an animated or scripted one needs the web view the push gives it.
    private static let pictureExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "ico",
    ]

    static func isPicture(_ path: String) -> Bool {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex
        else { return false }
        return pictureExtensions.contains(
            String(name[name.index(after: dot)...]).lowercased()
        )
    }

    /// The Mac app has no asset cover, so its chips stay disabled labels.
    static var canShowOverlay: Bool {
        #if os(iOS)
        true
        #else
        false
        #endif
    }

    /// Whether a chip for this file leads anywhere — what a caller checks
    /// before drawing one, since a button that does nothing is worse than no
    /// button.
    static func canOpen(_ _: String) -> Bool {
        canShowOverlay
    }

    static func open(
        sessionId: String,
        path: String,
        overlay: Binding<AssetOverlayItem?>
    ) {
        guard canShowOverlay else { return }
        overlay.wrappedValue = AssetOverlayItem(sessionId: sessionId, path: path)
    }
}

extension View {
    /// Hosts the viewer `AssetOpen.open` lifts a file into. Put it on the
    /// same view that owns the state — a chip inside a lazily-built transcript
    /// row can present perfectly well, and presenting from higher up would
    /// mean threading the tapped file back down again.
    func assetOverlayPreview(
        _ asset: Binding<AssetOverlayItem?>,
        openPanel: OpenPanelAction
    ) -> some View {
        #if os(iOS)
        return fullScreenCover(item: asset) { item in
            AssetOverlayView(item: item, openPanel: openPanel)
        }
        #else
        return self
        #endif
    }
}

#if os(iOS)
private struct AssetOverlayView: View {
    let item: AssetOverlayItem
    let openPanel: OpenPanelAction

    private var asset: OS1API.SessionAsset {
        OS1API.SessionAsset(path: item.path, size: 0, mtime: "")
    }

    private func openAssets() {
        openPanel(.assets(sessionId: item.sessionId))
    }

    var body: some View {
        if AssetOpen.isPicture(item.path) {
            FullScreenImagePreview(
                items: [
                    PreviewImage(
                        id: item.id,
                        source: .asset(sessionId: item.sessionId, path: item.path),
                        label: item.name
                    )
                ],
                index: 0,
                topLeading: AnyView(
                    AssetActionsMenu(
                        sessionId: item.sessionId,
                        asset: asset,
                        onOpenAssets: openPanel.isAvailable ? openAssets : nil,
                        onDarkBackground: true
                    )
                )
            )
        } else {
            NavigationStack {
                AssetDetailView(
                    sessionId: item.sessionId,
                    asset: asset,
                    showsDone: true,
                    onOpenAssets: openPanel.isAvailable ? openAssets : nil
                )
            }
        }
    }
}
#endif
