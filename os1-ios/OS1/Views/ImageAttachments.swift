import SwiftUI
import PhotosUI

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
