import SwiftUI
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

/// Paperclip button that appends picked images to a binding. iOS picks from
/// the photo library (PhotosPicker); macOS opens the file panel — the natural
/// source on each platform.
struct AttachImagesButton: View {
    @Binding var images: [AttachedImage]
    var maxCount: Int = 6
    var systemImage = "paperclip"

    #if os(iOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    #else
    @State private var importing = false
    #endif

    private var remaining: Int { max(0, maxCount - images.count) }

    var body: some View {
        #if os(iOS)
        PhotosPicker(
            selection: $pickerItems,
            maxSelectionCount: remaining,
            matching: .images
        ) {
            icon
        }
        // Plain, like the macOS branch: the default picker button style
        // tints the paperclip blue instead of leaving it secondary gray.
        .buttonStyle(.plain)
        .disabled(remaining == 0)
        .onChange(of: pickerItems) {
            guard !pickerItems.isEmpty else { return }
            let picked = pickerItems
            pickerItems = []
            Task {
                for item in picked {
                    guard let data = try? await item.loadTransferable(type: Data.self),
                          let image = AttachedImage(rawData: data)
                    else { continue }
                    if images.count < maxCount { images.append(image) }
                }
            }
        }
        #else
        Button {
            importing = true
        } label: {
            icon
        }
        .buttonStyle(.plain)
        .disabled(remaining == 0)
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.image],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(remaining) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url),
                      let image = AttachedImage(rawData: data)
                else { continue }
                images.append(image)
            }
        }
        #endif
    }

    private var icon: some View {
        Image(systemName: systemImage)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(.secondary)
            #if os(iOS)
            .frame(width: 44, height: 44)
            #else
            .frame(width: 27, height: 27)
            #endif
            .contentShape(Circle())
    }
}

/// One picture in a full-screen gallery: where its bytes come from, and the
/// label shown under it. Opening any image opens the whole group it belongs
/// to — the images of one message, the stills of one walkthrough — because a
/// viewer that can only ever show the picture you tapped makes you close and
/// re-open it to compare a before with its after.
struct PreviewImage: Identifiable, Equatable {
    enum WalkthroughLabel: String, Equatable {
        case before = "Before"
        case after = "After"
    }

    enum Source: Equatable {
        case data(Data)
        case conversation(source: String, sessionId: String)
        case media(path: String)
        /// A file in a session's scratch folder, by path — what a transcript's
        /// asset chip points at. Its own case rather than a `conversation`
        /// source: assets are served from their own route, and the path in
        /// that URL is what makes them resolvable at all.
        case asset(sessionId: String, path: String)
        /// A support message's attachment, by id. Fetched through the proxy
        /// that carries the app's token, the same way the thread renders its
        /// inline copy.
        case support(id: String)
    }

    let id: String
    let source: Source
    /// What this picture is, shown at the bottom of the viewer: a walkthrough's
    /// caption, or a markdown image's alt text.
    var label: String?
    /// Walkthrough media keeps its role separate so the viewer can render a
    /// recognizable status pill without styling an arbitrary image caption.
    var walkthroughLabel: WalkthroughLabel?

    init(
        id: String,
        source: Source,
        label: String? = nil,
        walkthroughLabel: WalkthroughLabel? = nil
    ) {
        self.id = id
        self.source = source
        self.label = label
        self.walkthroughLabel = walkthroughLabel
    }
}

/// Horizontal strip of attached-image thumbnails, each removable and openable
/// to check what was actually attached before sending it. At 56pt a screenshot
/// is unreadable, so the thumbnail alone can't answer "is this the right
/// one?"; the ✕ stays on top of the tap target, so removing still takes one
/// tap rather than a trip through the viewer.
///
/// Each platform opens it in its own grammar — full screen on the phone, a
/// sheet on the Mac — but neither is left without the answer.
struct AttachedImagesRow: View {
    let images: [AttachedImage]
    let onRemove: (AttachedImage) -> Void

    @State private var previewing: AttachedImage?

    #if os(iOS)
    private var gallery: [PreviewImage] {
        images.map { PreviewImage(id: $0.id, source: .data($0.jpegData)) }
    }
    #endif

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(images) { image in
                    ZStack(alignment: .topTrailing) {
                        thumbnail(image)
                        Button {
                            onRemove(image)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 15))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .buttonStyle(.plain)
                        .padding(2)
                    }
                }
            }
            .padding(.vertical, 2)
        }
        // `item:` rather than a bool, on both: the presentation renders the
        // image it was opened with even if the strip changes underneath it.
        #if os(iOS)
        .fullScreenCover(item: $previewing) { image in
            FullScreenImagePreview(
                items: gallery,
                index: images.firstIndex(of: image) ?? 0
            )
        }
        #else
        .sheet(item: $previewing) { image in
            MacImagePreview(
                images: images.map(\.jpegData),
                index: images.firstIndex(of: image) ?? 0
            )
        }
        #endif
    }

    private func thumbnail(_ image: AttachedImage) -> some View {
        Button {
            previewing = image
        } label: {
            thumbnailImage(image)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open attached image")
        #if os(iOS)
        .accessibilityHint("Shows the image full screen")
        #else
        .accessibilityHint("Shows the image larger")
        .help("Open attached image")
        #endif
    }

    private func thumbnailImage(_ image: AttachedImage) -> some View {
        DataImage(data: image.jpegData)
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Renders encoded image bytes (or a `data:` URL) cross-platform.
struct DataImage: View {
    let data: Data

    init(data: Data) {
        self.data = data
    }

    init?(dataURL: String) {
        guard let data = Self.decode(dataURL: dataURL) else { return nil }
        self.data = data
    }

    static func decode(dataURL: String) -> Data? {
        guard let comma = dataURL.range(of: ";base64,"),
              dataURL.hasPrefix("data:image/")
        else { return nil }
        return Data(base64Encoded: String(dataURL[comma.upperBound...]))
    }

    var body: some View {
        #if canImport(UIKit)
        if let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            placeholder
        }
        #else
        if let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFill()
        } else {
            placeholder
        }
        #endif
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.fill.tertiary)
            .overlay {
                Image(systemName: "photo")
                    .foregroundStyle(.tertiary)
            }
    }
}

/// A sent conversation image. A tap opens the familiar full-screen iOS
/// viewer; a pinch zooms it where it sits, without going anywhere (see
/// `pinchToPeek`). Composer thumbnails (`AttachedImagesRow`) open the same
/// viewer on tap, but keep the ✕ as their primary interaction.
///
/// A click opens it on the Mac too, in that platform's sheet. What the Mac
/// does NOT get is the group: paging needs every picture of the message, and
/// the rest of them are still URLs that only the iOS viewer knows how to
/// fetch. One picture you can read beats a transcript of pictures you cannot
/// open, so the sheet shows the one you clicked and says nothing about a
/// group it cannot page through.
struct ExpandableDataImage: View {
    let data: Data
    /// The group this picture belongs to, and where it sits in it. Empty means
    /// it stands alone — the viewer then shows just this one.
    var gallery: [PreviewImage] = []
    var galleryIndex: Int = 0

    @State private var previewPresented = false

    #if os(iOS)
    private var items: [PreviewImage] {
        gallery.isEmpty
            ? [PreviewImage(id: "single", source: .data(data))]
            : gallery
    }
    #endif

    init(data: Data, gallery: [PreviewImage] = [], galleryIndex: Int = 0) {
        self.data = data
        self.gallery = gallery
        self.galleryIndex = galleryIndex
    }

    init?(dataURL: String) {
        guard let data = DataImage.decode(dataURL: dataURL) else { return nil }
        self.data = data
    }

    var body: some View {
        #if os(iOS)
        Button {
            previewPresented = true
        } label: {
            DataImage(data: data)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open image")
        .accessibilityHint("Shows the image full screen")
        // Pinch the picture right here, rather than as a shortcut into the
        // viewer: the image lifts off the transcript, follows the fingers and
        // springs back. A presentation can't be part of that gesture — it
        // takes the presenting hierarchy out of the window and cancels the
        // touches with it — so the zoom has to happen in place.
        .pinchToPeek(data)
        .fullScreenCover(isPresented: $previewPresented) {
            FullScreenImagePreview(items: items, index: gallery.isEmpty ? 0 : galleryIndex)
        }
        #else
        Button {
            previewPresented = true
        } label: {
            DataImage(data: data)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open image")
        .accessibilityHint("Shows the image larger")
        .help("Open image")
        .sheet(isPresented: $previewPresented) {
            MacImagePreview(images: [data], index: 0)
        }
        #endif
    }
}

/// Lazily resolves either an inline data URL, a bounded transcript blob, or a
/// remote image before handing it to the full-screen-capable renderer.
struct ConversationImage: View {
    let source: String
    let sessionId: String
    /// The other images of the same message/tool result, so the viewer can
    /// page across them.
    var gallery: [PreviewImage] = []
    var galleryIndex: Int = 0

    @State private var data: Data?
    @State private var failed = false
    @State private var retryCount = 0

    init(
        source: String,
        sessionId: String,
        gallery: [PreviewImage] = [],
        galleryIndex: Int = 0
    ) {
        self.source = source
        self.sessionId = sessionId
        self.gallery = gallery
        self.galleryIndex = galleryIndex
        _data = State(initialValue: DataImage.decode(dataURL: source))
    }

    var body: some View {
        Group {
            if let data {
                ExpandableDataImage(data: data, gallery: gallery, galleryIndex: galleryIndex)
            } else if failed {
                Button {
                    retryCount += 1
                } label: {
                    imagePlaceholder(showingError: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry image")
            } else {
                imagePlaceholder(showingError: false)
            }
        }
        .task(id: "\(source)#\(retryCount)") {
            guard data == nil else { return }
            failed = false
            do {
                data = try await OS1API.conversationImage(source: source, sessionId: sessionId)
            } catch {
                failed = true
            }
        }
    }

    private func imagePlaceholder(showingError: Bool) -> some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(.fill.tertiary)
            .overlay {
                if showingError {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(.tertiary)
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
    }
}

/// Every image of one message or tool result, as many per row as fit and the
/// rest wrapped underneath.
///
/// Thumbnails are a fixed size, so four of them are wider than a phone — and a
/// bare `HStack` of them doesn't merely spill: it makes the whole transcript
/// that wide, and every neighbouring line is then laid out on a column bigger
/// than the screen and clipped on BOTH edges, while the pictures past the
/// third sit off-screen with no way to reach them. An adaptive grid can't
/// overflow at any count, and it shows every picture, which a sideways-
/// scrolling row does not: measured on device, a scroll view around this
/// content reports a content size equal to its own width, so the extra
/// thumbnails stay clipped and every drag springs back.
///
/// `alignment` is the end the pictures hug — a user's own message aligns with
/// the trailing edge of their bubble.
struct ConversationImageStrip: View {
    let sources: [String]
    let sessionId: String
    var size: CGFloat = 96
    var cornerRadius: CGFloat = 12
    var alignment: HorizontalAlignment = .leading

    /// The row is the group: opening one of several images pages through the
    /// rest rather than making you close and tap the next thumbnail.
    private var gallery: [PreviewImage] {
        sources.enumerated().map { index, source in
            PreviewImage(
                id: "\(index)",
                source: .conversation(source: source, sessionId: sessionId)
            )
        }
    }

    /// What a single row of every picture would take. The grid is capped at
    /// it so that a few pictures stay their own size and can hug the trailing
    /// edge in a user's bubble, instead of a full-width grid stretching them
    /// across the transcript; past the cap the grid takes what's available and
    /// wraps.
    private var naturalWidth: CGFloat {
        CGFloat(sources.count) * size + CGFloat(max(0, sources.count - 1)) * 6
    }

    var body: some View {
        if !sources.isEmpty {
            grid
                .frame(maxWidth: naturalWidth)
                .frame(
                    maxWidth: .infinity,
                    alignment: Alignment(horizontal: alignment, vertical: .center)
                )
        }
    }

    private var grid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: size * 0.75, maximum: size), spacing: 6)],
            alignment: alignment,
            spacing: 6
        ) {
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                ConversationImage(
                    source: source,
                    sessionId: sessionId,
                    gallery: gallery,
                    galleryIndex: index
                )
                .frame(height: size)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            }
        }
    }
}

#if os(macOS)
/// A staged picture, large enough to check before it goes out.
///
/// A sheet rather than a window of its own. Quick Look's floating panel is the
/// Mac's shape for a file you are browsing, and it detaches on purpose: it
/// outlives whatever opened it, and you close it yourself. This picture is
/// part of a message being written in this window, and the question it answers
/// — "is that the right screenshot?" — lasts seconds, so the preview belongs
/// to the window holding the composer and leaves with Escape. The phone's
/// `fullScreenCover` has no macOS counterpart anyway, and taking the whole
/// display for a glance would be phone grammar on a desk.
///
/// Bytes rather than `PreviewImage`, which is what the iOS viewer takes: every
/// source it would have to resolve (a transcript blob, an asset path, a
/// support attachment) is fetched by an iOS-only loader, and a viewer that
/// silently skipped the sources it cannot draw would page past pictures
/// without saying so. A composer's attachments are always bytes in hand.
struct MacImagePreview: View {
    let images: [Data]

    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    private let idealHeight: CGFloat

    init(images: [Data], index: Int) {
        self.images = images
        _index = State(initialValue: min(max(index, 0), max(images.count - 1, 0)))
        idealHeight = Self.idealHeight(for: images.first)
    }

    var body: some View {
        VStack(spacing: 0) {
            picture
            Divider()
            controls
        }
        .frame(minWidth: 480, idealWidth: Self.idealWidth, minHeight: 380, idealHeight: idealHeight)
    }

    private static let idealWidth: CGFloat = 760

    /// The sheet takes the shape of the picture it opens on, so a wide
    /// screenshot doesn't sit in a tall pane of empty grey. It keeps that shape
    /// while you page: a sheet that resized itself under the arrow keys would
    /// move the button you were about to click again.
    private static func idealHeight(for data: Data?) -> CGFloat {
        guard let data, let image = NSImage(data: data), image.size.width > 0 else { return 620 }
        let padding: CGFloat = 32
        let controls: CGFloat = 53
        let drawn = (idealWidth - padding) * (image.size.height / image.size.width)
        return min(max(drawn + padding + controls, 380), 900)
    }

    /// The well is the panel surface rather than white: most of what lands
    /// here is a screenshot of a light UI, and on white you cannot see where
    /// the picture ends.
    private var picture: some View {
        ZStack {
            OS1VisualStyle.panel
            if images.indices.contains(index), let image = NSImage(data: images[index]) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Paging is buttons carrying the arrow keys rather than `onKeyPress`,
    /// which only fires for a focused view: in a sheet that focus belongs to
    /// the default button, so the keys would work or not depending on where
    /// you last clicked.
    @ViewBuilder private var controls: some View {
        HStack(spacing: 12) {
            if images.count > 1 {
                Button { step(-1) } label: { Image(systemName: "chevron.left") }
                    .keyboardShortcut(.leftArrow, modifiers: [])
                    .disabled(index == 0)
                    .accessibilityLabel("Previous image")
                Text("\(index + 1) of \(images.count)")
                    .font(.callout)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Button { step(1) } label: { Image(systemName: "chevron.right") }
                    .keyboardShortcut(.rightArrow, modifiers: [])
                    .disabled(index == images.count - 1)
                    .accessibilityLabel("Next image")
            }
            Spacer()
            Button("Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(12)
    }

    private func step(_ delta: Int) {
        let next = index + delta
        guard images.indices.contains(next) else { return }
        index = next
    }
}
#endif

#if os(iOS)
/// The full-screen viewer: one picture at a time, swiping sideways to the rest
/// of its group and down to dismiss. Paging is a `TabView` rather than a
/// hand-rolled gesture so it carries the platform's own rubber-banding and
/// interruptible tracking; at the fit scale the zoom view hands horizontal
/// drags straight to it (see `ZoomScrollView.zoomDidChange`), and zoomed in it
/// keeps them to pan the photo.
struct FullScreenImagePreview: View {
    let items: [PreviewImage]
    private let topLeading: AnyView?

    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var dragOffset: CGSize = .zero

    init(items: [PreviewImage], index: Int, topLeading: AnyView? = nil) {
        self.items = items
        self.topLeading = topLeading
        _index = State(initialValue: min(max(index, 0), max(items.count - 1, 0)))
    }

    private var dismissalProgress: CGFloat {
        min(abs(dragOffset.height) / 280, 1)
    }

    private var label: String? {
        guard items.indices.contains(index) else { return nil }
        let label = items[index].label
        return (label?.isEmpty ?? true) ? nil : label
    }

    private var walkthroughLabel: PreviewImage.WalkthroughLabel? {
        guard items.indices.contains(index) else { return nil }
        return items[index].walkthroughLabel
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black
                .opacity(1 - dismissalProgress * 0.55)
                .ignoresSafeArea()

            TabView(selection: $index) {
                ForEach(Array(items.enumerated()), id: \.offset) { position, item in
                    PreviewPage(
                        item: item,
                        onDragChanged: { dragOffset = $0 },
                        onDragEnded: { translation, projected in
                            if abs(translation.height) > 100 || abs(projected.height) > 220 {
                                dismiss()
                            } else {
                                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                    dragOffset = .zero
                                }
                            }
                        },
                        onEscape: { dismiss() }
                    )
                    .tag(position)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .offset(x: dragOffset.width * 0.08, y: dragOffset.height)
            .scaleEffect(1 - dismissalProgress * 0.08)
            .ignoresSafeArea()

            HStack {
                if let topLeading { topLeading }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(.black.opacity(0.55), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close image")
            }
            .padding(16)
        }
        .overlay(alignment: .bottom) { caption }
        .statusBarHidden()
    }

    /// What you are looking at, at the bottom of the picture: the caption first,
    /// the position in the group under it. Over a scrim, because a screenshot
    /// is as likely to be white there as black. It fades out with the
    /// dismissal drag so the photo leaves alone.
    @ViewBuilder private var caption: some View {
        if walkthroughLabel != nil || label != nil || items.count > 1 {
            VStack(spacing: 3) {
                if walkthroughLabel != nil || label != nil {
                    HStack(spacing: 8) {
                        if let label {
                            Text(label)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                        }
                        if let walkthroughLabel {
                            Text(walkthroughLabel.rawValue)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(walkthroughLabel.color)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(walkthroughLabel.color.opacity(0.18), in: Capsule())
                                .overlay { Capsule().stroke(.white.opacity(0.18), lineWidth: 0.5) }
                        }
                    }
                }
                if items.count > 1 {
                    Text("\(index + 1) of \(items.count)")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.white.opacity(0.65))
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 44)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity)
            // The scrim has to be dark under the text and gone above it: most
            // of what this viewer shows is a screenshot of a light UI, and a
            // gradient that only reaches half strength at the baseline leaves
            // white type on near-white pixels.
            .background(
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0), location: 0),
                        .init(color: .black.opacity(0.5), location: 0.25),
                        .init(color: .black.opacity(0.82), location: 0.5),
                        .init(color: .black.opacity(0.9), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .opacity(1 - dismissalProgress)
            .allowsHitTesting(false)
            .accessibilityElement(children: .combine)
        }
    }
}

private extension PreviewImage.WalkthroughLabel {
    var color: Color {
        switch self {
        case .before: OS1VisualStyle.red
        case .after: OS1VisualStyle.green
        }
    }
}

/// One page of the viewer: resolves its bytes — already in hand, a transcript
/// image, or a staged walkthrough still — and hands them to the zoom surface.
private struct PreviewPage: View {
    let item: PreviewImage
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: (_ translation: CGSize, _ projected: CGSize) -> Void
    let onEscape: () -> Void

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                ZoomableImage(
                    image: image,
                    onDragChanged: onDragChanged,
                    onDragEnded: onDragEnded,
                    onEscape: onEscape
                )
            } else if failed {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 22))
                    .foregroundStyle(.white.opacity(0.5))
            } else {
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .task(id: item.id) {
            guard image == nil else { return }
            switch item.source {
            case .data(let data):
                image = UIImage(data: data)
            case .conversation(let source, let sessionId):
                let loaded = try? await OS1API.conversationImage(
                    source: source, sessionId: sessionId
                )
                image = loaded.flatMap(UIImage.init(data:))
            case .media(let path):
                let loaded = try? await OS1API.media(path: path)
                image = loaded.flatMap(UIImage.init(data:))
            case .asset(let sessionId, let path):
                let loaded = try? await OS1API.assetData(
                    sessionId: sessionId, path: path
                )
                image = loaded.flatMap(UIImage.init(data:))
            case .support(let id):
                let loaded = try? await OS1API.supportAttachment(id: id)
                image = loaded.flatMap(UIImage.init(data:))
            }
            failed = image == nil
        }
    }
}

/// Pinch-, double-tap- and pan-to-zoom, on a `UIScrollView`.
///
/// SwiftUI has no zooming container even on iOS 26, and composed
/// `MagnifyGesture`/`DragGesture` can't reach the feel people expect from
/// Photos: rubber-banding past the zoom limits, pan deceleration, and panning
/// with two fingers still down mid-pinch (a `DragGesture` ends the moment a
/// second finger lands). UIKit gives all of that for free.
///
/// Drag-to-dismiss lives in here too rather than as a SwiftUI gesture on the
/// parent: the scroll view's own pan recognizer begins whether or not there is
/// anywhere to scroll and wins the arbitration, so a parent `DragGesture`
/// would simply never fire. The dismissal pan is a UIKit recognizer that only
/// begins while fully zoomed out (zoomed in, a swipe pans the image instead)
/// and never with a second finger down, so a sloppy pinch can't dismiss the
/// viewer. Its translation is reported back so SwiftUI keeps owning the
/// backdrop fade and the dismiss/spring-back decision.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: (_ translation: CGSize, _ projected: CGSize) -> Void
    let onEscape: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ZoomScrollView {
        let scrollView = ZoomScrollView()
        scrollView.delegate = context.coordinator
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.backgroundColor = .clear
        scrollView.imageView.image = image
        context.coordinator.scrollView = scrollView

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        let dismissPan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDismissPan(_:))
        )
        // A pinch is two fingers: capping the touch count is what keeps one
        // from ever being read as a dismissal drag.
        dismissPan.maximumNumberOfTouches = 1
        dismissPan.delegate = context.coordinator
        scrollView.addGestureRecognizer(dismissPan)

        return scrollView
    }

    func updateUIView(_ scrollView: ZoomScrollView, context: Context) {
        context.coordinator.onDragChanged = onDragChanged
        context.coordinator.onDragEnded = onDragEnded
        scrollView.onEscape = onEscape
        if scrollView.imageView.image !== image {
            scrollView.imageView.image = image
            scrollView.setNeedsLayout()
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        weak var scrollView: ZoomScrollView?
        var onDragChanged: ((CGSize) -> Void)?
        var onDragEnded: ((CGSize, CGSize) -> Void)?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            (scrollView as? ZoomScrollView)?.imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            (scrollView as? ZoomScrollView)?.zoomDidChange()
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scrollView else { return }
            guard scrollView.isZoomedOut else {
                scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
                return
            }
            let target = scrollView.doubleTapZoomScale
            let point = gesture.location(in: scrollView.imageView)
            let size = CGSize(
                width: scrollView.bounds.width / target,
                height: scrollView.bounds.height / target
            )
            scrollView.zoom(
                to: CGRect(
                    x: point.x - size.width / 2,
                    y: point.y - size.height / 2,
                    width: size.width,
                    height: size.height
                ),
                animated: true
            )
        }

        @objc func handleDismissPan(_ gesture: UIPanGestureRecognizer) {
            guard let scrollView else { return }
            let translation = gesture.translation(in: scrollView)
            switch gesture.state {
            case .changed:
                onDragChanged?(CGSize(width: translation.x, height: translation.y))
            case .ended:
                // Stand-in for SwiftUI's `predictedEndTranslation`, which the
                // dismissal thresholds were tuned against.
                let velocity = gesture.velocity(in: scrollView)
                onDragEnded?(
                    CGSize(width: translation.x, height: translation.y),
                    CGSize(
                        width: translation.x + velocity.x * 0.25,
                        height: translation.y + velocity.y * 0.25
                    )
                )
            case .cancelled, .failed:
                onDragEnded?(.zero, .zero)
            default:
                break
            }
        }

        /// Dismissal only from the fit scale, and only for a vertical drag —
        /// zoomed in, the scroll view's own pan owns every direction.
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer,
                  let scrollView,
                  scrollView.isZoomedOut
            else { return false }
            let velocity = pan.velocity(in: scrollView)
            return abs(velocity.y) > abs(velocity.x)
        }

        func gestureRecognizer(
            _ gesture: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

/// Scroll view that keeps its zoom limits in step with its bounds and the
/// image, and keeps the image centered while it is smaller than the screen.
final class ZoomScrollView: UIScrollView {
    let imageView = UIImageView()
    var onEscape: (() -> Void)?
    private(set) var doubleTapZoomScale: CGFloat = 1

    private var laidOutBounds: CGSize = .zero
    private var laidOutImage: CGSize = .zero
    /// The pager this page sits in, while it is being held still.
    private weak var lockedPager: UIScrollView?

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        imageView.accessibilityLabel = "Image"
        addSubview(imageView)
        bouncesZoom = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var isZoomedOut: Bool { zoomScale <= minimumZoomScale + 0.01 }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0,
              let size = imageView.image?.size, size.width > 0, size.height > 0
        else { return }
        // Rebuilding on every pass would fight `zoom(to:)`; only a genuinely
        // new box or image invalidates the scales. The first pass inside a
        // `fullScreenCover` can be zero-sized, which is why it is guarded.
        if bounds.size != laidOutBounds || size != laidOutImage {
            laidOutBounds = bounds.size
            laidOutImage = size
            configureZoom(for: size)
        }
        centerContent()
    }

    private func configureZoom(for size: CGSize) {
        imageView.frame = CGRect(origin: .zero, size: size)
        contentSize = size

        let fit = min(bounds.width / size.width, bounds.height / size.height)
        // Zooming to one image pixel per device pixel is what makes the dense
        // UI screenshots this viewer mostly shows readable; the 4x floor keeps
        // small images zoomable at all.
        let displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        let pixelPerfect = (imageView.image?.scale ?? 1) / displayScale
        minimumZoomScale = fit
        maximumZoomScale = max(fit * 4, pixelPerfect)
        doubleTapZoomScale = min(maximumZoomScale, max(fit * 2, pixelPerfect))
        zoomScale = fit
        zoomDidChange()
    }

    /// Called on every zoom change: the image only bounces once there is
    /// somewhere to pan, so at the fit scale a vertical drag belongs entirely
    /// to the dismissal gesture — and its horizontal drag to the pager around
    /// it, which is why the scroll view's own pan steps aside there. The pinch
    /// recognizer is left alone (disabling `isScrollEnabled` would be the
    /// blunter way to do this), so zooming back in still works.
    func zoomDidChange() {
        bounces = !isZoomedOut
        panGestureRecognizer.isEnabled = !isZoomedOut
        // …and the pager steps aside in return once the photo is zoomed:
        // otherwise a sideways drag turns the page instead of panning, and the
        // page it lands back on is a fresh view at the fit scale, so the zoom
        // silently disappears. Zoom out to page again — the same trade Photos
        // makes.
        setPagingEnabled(isZoomedOut)
        centerContent()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Leaving while zoomed in must not leave the pager frozen behind us.
        if window == nil { setPagingEnabled(true) }
    }

    private func setPagingEnabled(_ enabled: Bool) {
        if enabled {
            lockedPager?.isScrollEnabled = true
            lockedPager = nil
        } else if lockedPager == nil, let pager = enclosingScrollView() {
            pager.isScrollEnabled = false
            lockedPager = pager
        }
    }

    /// The nearest scroll view above this one — the pager, when the viewer is
    /// showing a group rather than a single picture.
    private func enclosingScrollView() -> UIScrollView? {
        var next = superview
        while let view = next {
            if let scroll = view as? UIScrollView { return scroll }
            next = view.superview
        }
        return nil
    }

    private func centerContent() {
        let insetX = max(0, (bounds.width - imageView.frame.width) / 2)
        let insetY = max(0, (bounds.height - imageView.frame.height) / 2)
        contentInset = UIEdgeInsets(top: insetY, left: insetX, bottom: insetY, right: insetX)
    }

    /// VoiceOver's two-finger scrub, which users expect to close a full-screen
    /// cover.
    override func accessibilityPerformEscape() -> Bool {
        onEscape?()
        return true
    }
}
#endif

// ── Pasting images ────────────────────────────────────────────────────────

#if os(macOS)
extension View {
    /// Cmd+V of a copied screenshot/image drops it into the attachments.
    ///
    /// Not `onPasteCommand`: with a focused TextEditor/TextField the backing
    /// NSTextView is the first responder for the Paste command and swallows
    /// image pastes silently, so SwiftUI's handler never fires. A local
    /// key-event monitor scoped to this view's window sees Cmd+V before the
    /// responder chain, claims it only when the pasteboard actually carries
    /// an image, and lets every other paste reach the text view untouched.
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6
    ) -> some View {
        background(ImagePasteMonitor(images: images, maxCount: maxCount))
    }
}

private struct ImagePasteMonitor: NSViewRepresentable {
    @Binding var images: [AttachedImage]
    var maxCount: Int

    func makeNSView(context: Context) -> MonitorView { MonitorView() }

    func updateNSView(_ view: MonitorView, context: Context) {
        view.onPaste = { datas in
            for data in datas {
                guard images.count < maxCount,
                      let image = AttachedImage(rawData: data)
                else { continue }
                images.append(image)
            }
        }
    }

    final class MonitorView: NSView {
        var onPaste: (([Data]) -> Void)?
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                removeMonitor()
            } else if monitor == nil {
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
                    [weak self] event in
                    guard let self, self.claims(event) else { return event }
                    return nil
                }
            }
        }

        /// Plain Cmd+V, in this view's own window, with image content on the
        /// pasteboard. Anything else stays on the normal responder path.
        private func claims(_ event: NSEvent) -> Bool {
            guard event.window === window,
                  event.modifierFlags.intersection(
                      [.command, .shift, .option, .control]
                  ) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v"
            else { return false }
            let datas = NSPasteboard.general.imageDataRepresentations()
            guard !datas.isEmpty else { return false }
            onPaste?(datas)
            return true
        }

        private func removeMonitor() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }

        deinit { removeMonitor() }
    }
}

extension NSPasteboard {
    /// Raw bytes of every image on the pasteboard: direct image flavors
    /// (screenshots, a browser's "Copy Image") plus copied files that are
    /// themselves images (Finder, the screenshot thumbnail).
    func imageDataRepresentations() -> [Data] {
        (pasteboardItems ?? []).compactMap { item in
            if let type = item.types.first(where: {
                UTType($0.rawValue)?.conforms(to: .image) == true
            }) {
                return item.data(forType: type)
            }
            guard let urlString = item.string(forType: .fileURL),
                  let url = URL(string: urlString),
                  let type = UTType(filenameExtension: url.pathExtension),
                  type.conforms(to: .image)
            else { return nil }
            return try? Data(contentsOf: url)
        }
    }
}
#else
extension View {
    /// Long-press → Paste on the composer accepts images. SwiftUI text
    /// fields on iOS reject image pastes outright, so a background probe
    /// finds the UIKit text input backing the field, gives it a paste
    /// configuration that accepts images, a paste delegate that routes
    /// image flavors into the attachments — text pastes flow through
    /// untouched — and, via `ImagePasteMenu`, the Paste item the edit menu
    /// otherwise withholds. No extra button; the system edit menu is the
    /// affordance.
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6
    ) -> some View {
        background(TextInputPasteAugmenter(images: images, maxCount: maxCount))
    }
}

private struct TextInputPasteAugmenter: UIViewRepresentable {
    @Binding var images: [AttachedImage]
    var maxCount: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        context.coordinator.append = { data in
            guard images.count < maxCount,
                  let image = AttachedImage(rawData: data)
            else { return }
            images.append(image)
        }
        view.coordinator = context.coordinator
        view.augmentSoon()
    }

    final class Coordinator: NSObject, UITextPasteDelegate {
        var append: ((Data) -> Void)?

        func textPasteConfigurationSupporting(
            _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
            transform item: UITextPasteItem
        ) {
            let provider = item.itemProvider
            guard let type = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .image) == true
            }) else {
                item.setDefaultResult()
                return
            }
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                guard let data else { return }
                DispatchQueue.main.async { self.append?(data) }
            }
            item.setNoResult()
        }
    }

    /// Invisible view that locates the text input near it in the UIKit
    /// hierarchy and attaches the paste configuration + delegate. Re-runs on
    /// every update — SwiftUI can recreate the backing view under us.
    final class ProbeView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            augmentSoon()
        }

        func augmentSoon() {
            DispatchQueue.main.async { [weak self] in self?.augment() }
        }

        private func augment() {
            guard let coordinator else { return }
            // The probe sits as the field's background, so the input is a
            // close relative — walk a few ancestors, searching each subtree.
            var scope: UIView? = self
            for _ in 0..<5 {
                scope = scope?.superview
                guard let scope else { return }
                if let input = Self.findTextInput(in: scope) {
                    input.pasteConfiguration = UIPasteConfiguration(
                        forAccepting: UIImage.self
                    )
                    input.pasteDelegate = coordinator
                    ImagePasteMenu.enable(on: input)
                    return
                }
            }
        }

        private static func findTextInput(
            in view: UIView
        ) -> (UIView & UITextPasteConfigurationSupporting)? {
            if let match = view as? UIView & UITextPasteConfigurationSupporting {
                return match
            }
            for sub in view.subviews {
                if let match = findTextInput(in: sub) { return match }
            }
            return nil
        }
    }
}

/// Puts Paste back in the edit menu when the clipboard holds only an image.
///
/// SwiftUI's text views answer the menu's "does Paste apply here?" from the
/// text flavors alone and ignore the paste configuration set above, so an
/// image-only clipboard offers no Paste at all — even though the paste
/// pipeline underneath works (measured on iOS 26: configuration and delegate
/// both installed, `paste(nil)` attaches the image, `canPerformAction(paste:)`
/// false, long-press shows only AutoFill).
///
/// So the one broken link gets patched and nothing else: the augmented view
/// moves to a subclass that overrides `canPerformAction` alone, additively —
/// whatever the original answered yes to still wins, so no text paste can
/// regress — and adds Paste while an image is on the clipboard. Choosing it
/// runs the view's own paste, through the delegate installed above.
private enum ImagePasteMenu {
    private static let namePrefix = "OS1ImagePaste_"
    private static var subclasses: [ObjectIdentifier: AnyClass] = [:]

    static func enable(on input: UIView & UITextPasteConfigurationSupporting) {
        guard let current = object_getClass(input),
              !NSStringFromClass(current).hasPrefix(namePrefix),
              let patched = subclass(of: current)
        else { return }
        object_setClass(input, patched)
    }

    /// One subclass per base class, derived from the class the instance is
    /// actually wearing rather than one looked up by name: KVO plays the same
    /// trick, and layering on top of whatever is there keeps its behavior.
    private static func subclass(of base: AnyClass) -> AnyClass? {
        if let made = subclasses[ObjectIdentifier(base)] { return made }
        let selector = #selector(UIResponder.canPerformAction(_:withSender:))
        guard let method = class_getInstanceMethod(base, selector),
              let made = objc_allocateClassPair(
                  base, namePrefix + NSStringFromClass(base), 0
              )
        else { return nil }
        typealias Original =
            @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
        let original = unsafeBitCast(
            method_getImplementation(method), to: Original.self
        )
        let override: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = {
            view, action, sender in
            if original(view, selector, action, sender) { return true }
            guard action == #selector(UIResponder.paste(_:)),
                  let input = view as? UITextPasteConfigurationSupporting,
                  input.pasteDelegate != nil
            else { return false }
            // Metadata only: asking whether the clipboard holds images never
            // trips the paste-permission alert, where reading them would.
            return UIPasteboard.general.hasImages
        }
        class_addMethod(
            made,
            selector,
            imp_implementationWithBlock(override),
            method_getTypeEncoding(method)
        )
        objc_registerClassPair(made)
        subclasses[ObjectIdentifier(base)] = made
        return made
    }
}
#endif

extension View {
    /// `pastesImages`, but only while the surface is actually accepting them.
    /// A sheet that is offering no attachments has to leave Cmd+V to the text
    /// field: the Mac monitor claims the key whenever the pasteboard holds an
    /// image, so installing it unconditionally would swallow pastes that had
    /// nowhere to go.
    @ViewBuilder
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6, when enabled: Bool
    ) -> some View {
        if enabled {
            pastesImages(into: images, maxCount: maxCount)
        } else {
            self
        }
    }
}
