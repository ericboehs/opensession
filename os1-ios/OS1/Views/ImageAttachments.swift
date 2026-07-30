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
        Image(systemName: "paperclip")
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

/// Horizontal strip of attached-image thumbnails, each removable.
struct AttachedImagesRow: View {
    let images: [AttachedImage]
    let onRemove: (AttachedImage) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(images) { image in
                    ZStack(alignment: .topTrailing) {
                        DataImage(data: image.jpegData)
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
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

/// A sent conversation image that opens into the familiar full-screen iOS
/// viewer. Composer thumbnails deliberately stay non-expandable because their
/// primary interaction is removing the attachment before sending.
struct ExpandableDataImage: View {
    let data: Data

    #if os(iOS)
    @State private var previewPresented = false
    #endif

    init(data: Data) {
        self.data = data
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
        .fullScreenCover(isPresented: $previewPresented) {
            FullScreenImagePreview(data: data)
        }
        #else
        DataImage(data: data)
        #endif
    }
}

/// Lazily resolves either an inline data URL, a bounded transcript blob, or a
/// remote image before handing it to the full-screen-capable renderer.
struct ConversationImage: View {
    let source: String
    let sessionId: String

    @State private var data: Data?
    @State private var failed = false
    @State private var retryCount = 0

    init(source: String, sessionId: String) {
        self.source = source
        self.sessionId = sessionId
        _data = State(initialValue: DataImage.decode(dataURL: source))
    }

    var body: some View {
        Group {
            if let data {
                ExpandableDataImage(data: data)
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

#if os(iOS)
private struct FullScreenImagePreview: View {
    private let image: UIImage?

    @Environment(\.dismiss) private var dismiss
    @State private var dragOffset: CGSize = .zero

    init(data: Data) {
        image = UIImage(data: data)
    }

    private var dismissalProgress: CGFloat {
        min(abs(dragOffset.height) / 280, 1)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black
                .opacity(1 - dismissalProgress * 0.55)
                .ignoresSafeArea()

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .offset(x: dragOffset.width * 0.08, y: dragOffset.height)
                    .scaleEffect(1 - dismissalProgress * 0.08)
                    .padding(.horizontal, 8)
            }

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
            .padding(16)
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 5)
                .onChanged { value in
                    guard abs(value.translation.height) > abs(value.translation.width) else {
                        return
                    }
                    dragOffset = value.translation
                }
                .onEnded { value in
                    let projected = value.predictedEndTranslation.height
                    if abs(value.translation.height) > 100 || abs(projected) > 220 {
                        dismiss()
                    } else {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            dragOffset = .zero
                        }
                    }
                }
        )
        .statusBarHidden()
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
    /// configuration that accepts images, and a paste delegate that routes
    /// image flavors into the attachments — text pastes flow through
    /// untouched. No extra button; the system edit menu is the affordance.
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
#endif
