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
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(width: 27, height: 27)
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
        guard let comma = dataURL.range(of: ";base64,"),
              dataURL.hasPrefix("data:image/"),
              let decoded = Data(base64Encoded: String(dataURL[comma.upperBound...]))
        else { return nil }
        self.data = decoded
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

// ── Pasting images ────────────────────────────────────────────────────────

#if os(macOS)
extension View {
    /// Cmd+V of a copied screenshot/image drops it into the attachments.
    /// Scoped to image content: the handler only claims the Paste command
    /// when the pasteboard's content matches, so text pastes keep flowing
    /// to the focused text view untouched.
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6
    ) -> some View {
        onPasteCommand(of: [.image]) { providers in
            Task { @MainActor in
                for provider in providers {
                    guard images.wrappedValue.count < maxCount,
                          let data = await provider.imageDataRepresentation(),
                          let image = AttachedImage(rawData: data)
                    else { continue }
                    images.wrappedValue.append(image)
                }
            }
        }
    }
}

extension NSItemProvider {
    /// Raw bytes of the first image flavor this provider carries.
    func imageDataRepresentation() async -> Data? {
        let type = registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .image) == true
        }
        guard let type else { return nil }
        return await withCheckedContinuation { continuation in
            _ = loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }
}
#else
extension View {
    /// iOS text fields can't intercept paste; the PasteImagesButton next to
    /// the field covers it. No-op so call sites stay platform-free.
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6
    ) -> some View {
        self
    }
}

/// Wire form for the system PasteButton: any image flavor, imported as bytes.
struct PastedImage: Transferable {
    let data: Data

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { PastedImage(data: $0) }
    }
}

/// System paste button that appears next to the composer whenever the
/// pasteboard holds an image — the sanctioned way to read it without the
/// paste-permission prompt. (UIKit text fields ignore image pastes, so
/// without this a copied screenshot has no way in.)
struct PasteImagesButton: View {
    @Binding var images: [AttachedImage]
    var maxCount: Int = 6

    @State private var pasteboardHasImages = UIPasteboard.general.hasImages

    var body: some View {
        Group {
            if pasteboardHasImages {
                PasteButton(payloadType: PastedImage.self) { payloads in
                    Task { @MainActor in
                        for payload in payloads {
                            guard images.count < maxCount,
                                  let image = AttachedImage(rawData: payload.data)
                            else { continue }
                            images.append(image)
                        }
                    }
                }
                .labelStyle(.iconOnly)
                .controlSize(.small)
            }
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)
        ) { _ in
            pasteboardHasImages = UIPasteboard.general.hasImages
        }
        .onReceive(
            NotificationCenter.default.publisher(
                for: UIApplication.willEnterForegroundNotification
            )
        ) { _ in
            pasteboardHasImages = UIPasteboard.general.hasImages
        }
    }
}
#endif
